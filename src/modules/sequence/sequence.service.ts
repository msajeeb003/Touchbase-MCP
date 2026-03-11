import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import {
  CreateSequenceInput,
  UpdateSequenceInput,
} from "./sequence.validation";

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

const createSequence = async (userId: string, payload: CreateSequenceInput) => {
  const lead = await prisma.lead.findFirst({
    where: { id: payload.leadId, userId },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  const activeSequence = await prisma.sequence.findFirst({
    where: { leadId: payload.leadId, userId, status: "active" },
  });

  if (activeSequence) {
    throw new AppError(
      409,
      "This lead already has an active sequence. Pause or cancel it first."
    );
  }

  let promptTemplateId = payload.promptTemplateId || null;

  if (!promptTemplateId && lead.followUpStage) {
    const template = await prisma.promptTemplate.findFirst({
      where: { userId, followUpStage: lead.followUpStage },
    });
    if (template) {
      promptTemplateId = template.id;
    }
  }

  return prisma.sequence.create({
    data: {
      userId,
      leadId: payload.leadId,
      promptTemplateId,
      name: payload.name,
      totalSteps: payload.totalSteps,
    },
    include: {
      lead: { select: { name: true, email: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
    },
  });
};

const getSequences = async (userId: string, status?: string) => {
  const where: Record<string, unknown> = { userId };
  if (status) {
    where.status = status;
  }

  return prisma.sequence.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      lead: { select: { name: true, email: true, company: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
      _count: { select: { steps: true } },
    },
  });
};

const getSequenceById = async (userId: string, sequenceId: string) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, userId },
    include: {
      lead: { select: { name: true, email: true, company: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
      steps: { orderBy: { stepOrder: "asc" } },
    },
  });

  if (!sequence) {
    throw new AppError(404, "Sequence not found");
  }

  return sequence;
};

const activateSequence = async (userId: string, sequenceId: string) => {
  const sequence = await getSequenceById(userId, sequenceId);

  if (sequence.status !== "draft") {
    throw new AppError(400, `Cannot activate a "${sequence.status}" sequence`);
  }

  const stepCount = await prisma.sequenceStep.count({
    where: { sequenceId },
  });

  if (stepCount !== sequence.totalSteps) {
    throw new AppError(
      400,
      `All ${sequence.totalSteps} steps must be created before activation (currently ${stepCount})`
    );
  }

  const pendingSteps = await prisma.sequenceStep.count({
    where: { sequenceId, status: "pending" },
  });

  if (pendingSteps > 0) {
    throw new AppError(
      400,
      `${pendingSteps} step(s) have no content. Generate content for all steps before activation.`
    );
  }

  const pastSteps = await prisma.sequenceStep.findMany({
    where: {
      sequenceId,
      scheduledAt: { lte: new Date() },
    },
    select: { stepOrder: true },
  });

  if (pastSteps.length > 0) {
    const orders = pastSteps.map((s) => s.stepOrder).join(", ");
    throw new AppError(
      400,
      `Step(s) ${orders} have past scheduled dates. Update them before activation.`
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.sequenceStep.updateMany({
      where: { sequenceId, status: "draft" },
      data: { status: "scheduled" },
    });

    return tx.sequence.update({
      where: { id: sequenceId },
      data: { status: "active" },
      include: {
        lead: { select: { name: true, email: true, followUpStage: true } },
        promptTemplate: { select: { id: true, name: true, followUpStage: true } },
        steps: { orderBy: { stepOrder: "asc" } },
      },
    });
  });
};

const cancelSequence = async (userId: string, sequenceId: string) => {
  const sequence = await getSequenceById(userId, sequenceId);

  const allowed = ALLOWED_TRANSITIONS[sequence.status] || [];
  if (!allowed.includes("cancelled")) {
    throw new AppError(
      400,
      `Cannot cancel a "${sequence.status}" sequence`
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.sequenceStep.updateMany({
      where: {
        sequenceId,
        status: { in: ["pending", "draft", "scheduled"] },
      },
      data: { status: "skipped" },
    });

    return tx.sequence.update({
      where: { id: sequenceId },
      data: { status: "cancelled" },
      include: {
        lead: { select: { name: true, email: true, followUpStage: true } },
        promptTemplate: { select: { id: true, name: true, followUpStage: true } },
        steps: { orderBy: { stepOrder: "asc" } },
      },
    });
  });
};

const updateSequence = async (
  userId: string,
  sequenceId: string,
  payload: UpdateSequenceInput
) => {
  const sequence = await getSequenceById(userId, sequenceId);

  if (payload.status) {
    if (payload.status === "active") {
      return activateSequence(userId, sequenceId);
    }

    if (payload.status === "cancelled") {
      return cancelSequence(userId, sequenceId);
    }

    const allowed = ALLOWED_TRANSITIONS[sequence.status] || [];
    if (!allowed.includes(payload.status)) {
      throw new AppError(
        400,
        `Cannot change status from "${sequence.status}" to "${payload.status}"`
      );
    }
  }

  return prisma.sequence.update({
    where: { id: sequenceId },
    data: payload,
    include: {
      lead: { select: { name: true, email: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
    },
  });
};

const deleteSequence = async (userId: string, sequenceId: string) => {
  const sequence = await getSequenceById(userId, sequenceId);

  if (sequence.status === "active") {
    throw new AppError(
      400,
      "Cannot delete an active sequence. Pause or cancel it first."
    );
  }

  return prisma.sequence.delete({
    where: { id: sequenceId },
  });
};

export const SequenceService = {
  createSequence,
  getSequences,
  getSequenceById,
  updateSequence,
  deleteSequence,
};

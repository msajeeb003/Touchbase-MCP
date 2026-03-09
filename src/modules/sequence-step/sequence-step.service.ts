import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { CreateStepInput, UpdateStepInput } from "./sequence-step.validation";

const verifySequenceOwnership = async (
  userId: string,
  sequenceId: string
) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, userId },
  });

  if (!sequence) {
    throw new AppError(404, "Sequence not found");
  }

  return sequence;
};

const createStep = async (
  userId: string,
  sequenceId: string,
  payload: CreateStepInput
) => {
  const sequence = await verifySequenceOwnership(userId, sequenceId);

  if (sequence.status !== "draft") {
    throw new AppError(400, "Steps can only be added to draft sequences");
  }

  if (payload.stepOrder > sequence.totalSteps) {
    throw new AppError(
      400,
      `Step order cannot exceed total steps (${sequence.totalSteps})`
    );
  }

  const stepCount = await prisma.sequenceStep.count({
    where: { sequenceId },
  });

  if (stepCount >= sequence.totalSteps) {
    throw new AppError(
      400,
      `Sequence already has all ${sequence.totalSteps} steps`
    );
  }

  const scheduledDate = new Date(payload.scheduledAt);
  if (scheduledDate <= new Date()) {
    throw new AppError(400, "Scheduled date must be in the future");
  }

  if (payload.stepOrder > 1) {
    const previousStep = await prisma.sequenceStep.findFirst({
      where: { sequenceId, stepOrder: payload.stepOrder - 1 },
    });

    if (previousStep && scheduledDate <= previousStep.scheduledAt) {
      throw new AppError(
        400,
        `Scheduled date must be after step ${payload.stepOrder - 1}`
      );
    }
  }

  const nextStep = await prisma.sequenceStep.findFirst({
    where: { sequenceId, stepOrder: payload.stepOrder + 1 },
  });

  if (nextStep && scheduledDate >= nextStep.scheduledAt) {
    throw new AppError(
      400,
      `Scheduled date must be before step ${payload.stepOrder + 1}`
    );
  }

  return prisma.sequenceStep.create({
    data: {
      sequenceId,
      stepOrder: payload.stepOrder,
      stepType: payload.stepType,
      scheduledAt: scheduledDate,
    },
  });
};

const getSteps = async (userId: string, sequenceId: string) => {
  await verifySequenceOwnership(userId, sequenceId);

  return prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
  });
};

const getStepById = async (
  userId: string,
  sequenceId: string,
  stepId: string
) => {
  await verifySequenceOwnership(userId, sequenceId);

  const step = await prisma.sequenceStep.findFirst({
    where: { id: stepId, sequenceId },
  });

  if (!step) {
    throw new AppError(404, "Step not found");
  }

  return step;
};

const updateStep = async (
  userId: string,
  sequenceId: string,
  stepId: string,
  payload: UpdateStepInput
) => {
  const sequence = await verifySequenceOwnership(userId, sequenceId);

  if (sequence.status !== "draft") {
    throw new AppError(400, "Steps can only be edited in draft sequences");
  }

  const step = await getStepById(userId, sequenceId, stepId);

  const data: Record<string, unknown> = {};

  if (payload.stepType !== undefined) data.stepType = payload.stepType;
  if (payload.subject !== undefined) data.subject = payload.subject;
  if (payload.content !== undefined) data.content = payload.content;

  if (payload.scheduledAt) {
    const scheduledDate = new Date(payload.scheduledAt);
    if (scheduledDate <= new Date()) {
      throw new AppError(400, "Scheduled date must be in the future");
    }

    if (step.stepOrder > 1) {
      const previousStep = await prisma.sequenceStep.findFirst({
        where: { sequenceId, stepOrder: step.stepOrder - 1 },
      });
      if (previousStep && scheduledDate <= previousStep.scheduledAt) {
        throw new AppError(
          400,
          `Scheduled date must be after step ${step.stepOrder - 1}`
        );
      }
    }

    const nextStep = await prisma.sequenceStep.findFirst({
      where: { sequenceId, stepOrder: step.stepOrder + 1 },
    });
    if (nextStep && scheduledDate >= nextStep.scheduledAt) {
      throw new AppError(
        400,
        `Scheduled date must be before step ${step.stepOrder + 1}`
      );
    }

    data.scheduledAt = scheduledDate;
  }

  if (payload.content !== undefined || payload.subject !== undefined) {
    if (step.status === "pending") {
      data.status = "draft";
    }
  }

  return prisma.sequenceStep.update({
    where: { id: stepId },
    data,
  });
};

const deleteStep = async (
  userId: string,
  sequenceId: string,
  stepId: string
) => {
  const sequence = await verifySequenceOwnership(userId, sequenceId);

  if (sequence.status !== "draft") {
    throw new AppError(400, "Steps can only be deleted from draft sequences");
  }

  const step = await getStepById(userId, sequenceId, stepId);

  await prisma.$transaction(async (tx) => {
    await tx.sequenceStep.delete({ where: { id: stepId } });

    await tx.sequenceStep.updateMany({
      where: {
        sequenceId,
        stepOrder: { gt: step.stepOrder },
      },
      data: {
        stepOrder: { decrement: 1 },
      },
    });
  });

  return null;
};

export const SequenceStepService = {
  createStep,
  getSteps,
  getStepById,
  updateStep,
  deleteStep,
};

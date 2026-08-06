import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { SettingsService } from "../settings/settings.service";
import { generateContent } from "../../shared/services/ai.service";
import { type AIProvider, STEP_TYPE } from "../../shared/constants";
import { buildPrompt, parseAIResponse } from "../../shared/services/prompt-builder";
import {
  CreateStepInput,
  UpdateStepInput,
  ReorderStepsInput,
} from "./sequence-step.validation";
import { SEQUENCE_STEP_STATUS } from "../../shared/sequence-step";
import { SEQUENCE_STATUS } from "../../shared/constants";

const isDraftOrPaused = (status: string) =>
  status === SEQUENCE_STATUS.DRAFT || status === SEQUENCE_STATUS.PAUSED;

const assertDraftOnly = (status: string, action: string) => {
  if (status === SEQUENCE_STATUS.DRAFT) return;
  throw new AppError(400, `Set this sequence to draft to ${action}.`);
};

const assertDraftOrPaused = (status: string, action: string) => {
  if (isDraftOrPaused(status)) return;

  if (status === SEQUENCE_STATUS.ACTIVE) {
    throw new AppError(400, `Pause this sequence to ${action}.`);
  }

  throw new AppError(400, `Set this sequence to draft or paused to ${action}.`);
};

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

  assertDraftOnly(sequence.status, "add steps");

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

  const rows = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
    include: {
      callLogs: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  return rows.map(({ callLogs, ...step }) => {
    const latest = callLogs[0] ?? null;
    const callLog =
      step.stepType === STEP_TYPE.CALL &&
      step.status === SEQUENCE_STEP_STATUS.SENT &&
      latest
        ? latest
        : null;

    return { ...step, callLog };
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

  assertDraftOrPaused(sequence.status, "edit its steps");

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
    if (step.status === SEQUENCE_STEP_STATUS.PENDING) {
      data.status = SEQUENCE_STEP_STATUS.DRAFT;
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

  assertDraftOrPaused(sequence.status, "delete steps");

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

const deleteAllSteps = async (userId: string, sequenceId: string) => {
  const sequence = await verifySequenceOwnership(userId, sequenceId);

  assertDraftOrPaused(sequence.status, "delete steps");

  const result = await prisma.sequenceStep.deleteMany({
    where: { sequenceId },
  });

  return { deletedCount: result.count };
};

const generateStepContent = async (
  userId: string,
  sequenceId: string,
  stepId: string
) => {

  // STEP 1: Verify sequence ownership and status
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, userId },
    include: {
      lead: true,
      promptTemplate: true,
    },
  });


  if (!sequence) {
    throw new AppError(404, "Sequence not found");
  }

  assertDraftOnly(sequence.status, "generate step content");

  if (!sequence.promptTemplate) {
    throw new AppError(
      400,
      "No prompt template linked. Assign a prompt template to this sequence first."
    );
  }

  // STEP 2: Verify step exists
  const step = await prisma.sequenceStep.findFirst({
    where: { id: stepId, sequenceId },
  });

  if (!step) {
    throw new AppError(404, "Step not found");
  }

  // STEP 3: Verify previous step is not pending
  if (step.stepOrder > 1) {
    const immediatePreview = await prisma.sequenceStep.findFirst({
      where: { sequenceId, stepOrder: step.stepOrder - 1 },
    });

    if (
      !immediatePreview ||
      immediatePreview.status === SEQUENCE_STEP_STATUS.PENDING
    ) {
      throw new AppError(
        400,
        `Generate Step ${step.stepOrder - 1} first before generating Step ${step.stepOrder}`
      );
    }
  }

  // STEP 4: Get AI provider and API key
  const [aiProvider, aiApiKey, aiModel] = await Promise.all([
    prisma.userSettings.findUnique({
      where: { userId },
      select: { aiProvider: true, aiModel: true },
    }),
    SettingsService.getDecryptedField(userId, "aiApiKey"),
    null,
  ]);

  const provider = aiProvider?.aiProvider;
  const model = aiProvider?.aiModel;

  if (!provider || !aiApiKey) {
    throw new AppError(
      400,
      "AI provider and API key not configured. Please set them in Settings."
    );
  }

  // STEP 5: Get previous steps
  const previousSteps = await prisma.sequenceStep.findMany({
    where: {
      sequenceId,
      stepOrder: { lt: step.stepOrder },
      status: { not: SEQUENCE_STEP_STATUS.PENDING },
    },
    orderBy: { stepOrder: "asc" },
    select: {
      stepOrder: true,
      stepType: true,
      subject: true,
      content: true,
    },
  });

  // STEP 6: Get transcripts
  const transcripts = await prisma.leadTranscript.findMany({
    where: { leadId: sequence.leadId, userId },
    orderBy: { meetingDate: "desc" },
    select: { transcript: true },
    take: 3,
  });

  const transcriptText =
    transcripts.length > 0
      ? transcripts.map((t) => t.transcript).join("\n\n---\n\n")
      : null;
  // STEP 7: Build prompt
  const prompt = buildPrompt({
    promptText: sequence.promptTemplate.promptText,
    sequenceName: sequence.name,
    stepContext: {
      stepOrder: step.stepOrder,
      totalSteps: sequence.totalSteps,
      stepType: step.stepType,
    },
    previousSteps,
    lead: {
      name: sequence.lead.name,
      email: sequence.lead.email,
      phone: sequence.lead.phone,
      company: sequence.lead.company,
      location: sequence.lead.location,
      followUpStage: sequence.lead.followUpStage,
      notes: sequence.lead.notes,
    },
    transcript: transcriptText,
  });

  // STEP 8: Generate content
  const aiResponse = await generateContent(
    {
      provider: provider as AIProvider,
      apiKey: aiApiKey,
      model: model || undefined,
    },
    prompt
  );

  // STEP 9: Parse AI response
  const parsed = parseAIResponse(aiResponse.content, step.stepType);

  // STEP 10: Update step
  return prisma.sequenceStep.update({
    where: { id: stepId },
    data: {
      subject: parsed.subject,
      content: parsed.content,
      status: SEQUENCE_STEP_STATUS.DRAFT,
    },
  });
};

const regenerateAllStepsContent = async (userId: string, sequenceId: string) => {
  const steps = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
    select: { id: true, stepOrder: true },
  });

  if (steps.length === 0) {
    throw new AppError(400, "No steps to regenerate");
  }

  const results: { stepOrder: number; status: string; error?: string }[] = [];

  for (const s of steps) {
    try {
      await generateStepContent(userId, sequenceId, s.id);
      results.push({ stepOrder: s.stepOrder, status: "generated" });
    } catch (err) {
      const message =
        err instanceof AppError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error";
      results.push({
        stepOrder: s.stepOrder,
        status: SEQUENCE_STEP_STATUS.FAILED,
        error: message,
      });
    }
  }

  const updatedSteps = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
  });

  return { steps: updatedSteps, results };
};

const reorderSteps = async (
  userId: string,
  sequenceId: string,
  payload: ReorderStepsInput
) => {
  const sequence = await verifySequenceOwnership(userId, sequenceId);

  assertDraftOrPaused(sequence.status, "reorder its steps");

  const steps = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
  });

  if (steps.length === 0) {
    throw new AppError(400, "No steps to reorder");
  }

  const { orderedStepIds } = payload;

  if (orderedStepIds.length !== steps.length) {
    throw new AppError(
      400,
      `orderedStepIds must include all ${steps.length} step(s)`
    );
  }

  const uniqueIds = new Set(orderedStepIds);
  if (uniqueIds.size !== orderedStepIds.length) {
    throw new AppError(400, "orderedStepIds contains duplicate step IDs");
  }

  const stepById = new Map(steps.map((s) => [s.id, s]));
  for (const id of orderedStepIds) {
    if (!stepById.has(id)) {
      throw new AppError(400, `Step ${id} does not belong to this sequence`);
    }
  }

  // Position-based date slots: keep timeline fixed to order positions
  const slots = steps.map((s) => s.scheduledAt);

  // Interactive tx over Supabase can expire with many round-trips (default 5s).
  // Phase 1 = 1 query; Phase 2 = N updates; raise timeout for remote DB latency.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        UPDATE sequence_steps
        SET "stepOrder" = -ABS("stepOrder")
        WHERE "sequenceId" = ${sequenceId}
      `;

      for (let i = 0; i < orderedStepIds.length; i++) {
        await tx.sequenceStep.update({
          where: { id: orderedStepIds[i] },
          data: {
            stepOrder: i + 1,
            scheduledAt: slots[i],
          },
        });
      }
    },
    { maxWait: 15000, timeout: 60000 }
  );

  return prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
  });
};

export const SequenceStepService = {
  createStep,
  getSteps,
  getStepById,
  updateStep,
  deleteStep,
  deleteAllSteps,
  generateStepContent,
  regenerateAllStepsContent,
  reorderSteps,
};

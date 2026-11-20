import type { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { syncLeadStatusFromActiveSequences } from "../lead/lead.service";
import {
  DO_NOT_CONTACT_MESSAGE,
  isLeadBlocked,
} from "../../harness/do-not-contact";
import { computeApprovalHash } from "../../harness/approval";
import { loadSendWindow, planSendDates } from "../../harness/send-window";
import { SKIPPED_ON_REQUEST } from "../../harness/common";
import { refreshRunAfterApproval } from "../../harness/runs/run.service";
import {
  CreateSequenceInput,
  UpdateSequenceInput,
  GenerateSaveInput,
  CADENCE_REGEX,
} from "./sequence.validation";
import { buildWizardStepPrompt } from "../../shared/services/prompt-composer";
import { SettingsService } from "../settings/settings.service";
import { generateContent } from "../../shared/services/ai.service";
import { type AIProvider, STEP_TYPE_LIST } from "../../shared/constants";
import { buildPrompt, parseAIResponse } from "../../shared/services/prompt-builder";
import { SEQUENCE_STEP_STATUS } from "../../shared/sequence-step";
import { SEQUENCE_STATUS } from "../../shared/constants";
import { logActivity } from "../../shared/services/activity-logger";

const isDraftOrPaused = (status: string) =>
  status === SEQUENCE_STATUS.DRAFT || status === SEQUENCE_STATUS.PAUSED;

const assertDraftOrPaused = (status: string, action: string) => {
  if (isDraftOrPaused(status)) return;

  if (status === SEQUENCE_STATUS.ACTIVE) {
    throw new AppError(400, `Pause this sequence to ${action}.`);
  }

  throw new AppError(400, `Set this sequence to draft or paused to ${action}.`);
};

const createSequence = async (userId: string, payload: CreateSequenceInput) => {
  const lead = await prisma.lead.findFirst({
    where: { id: payload.leadId, userId, deletedAt: null },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  const activeSequence = await prisma.sequence.findFirst({
    where: { leadId: payload.leadId, userId, status: SEQUENCE_STATUS.ACTIVE },
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

  const created = await prisma.sequence.create({
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

  logActivity({
    sequenceId: created.id,
    eventType:  "sequence_created",
    actor:      "user",
    meta:       { name: created.name, totalSteps: created.totalSteps },
  });

  return created;
};

const stepTypeSentCounts = (
  steps: { stepType: string; status: string }[]
) => {
  const sent = SEQUENCE_STEP_STATUS.SENT;
  const failed = SEQUENCE_STEP_STATUS.FAILED;
  const calling = SEQUENCE_STEP_STATUS.CALLING;
  let emailSteps = 0;
  let smsSteps = 0;
  let whatsappSteps = 0;
  let callSteps = 0;
  let emailSent = 0;
  let smsSent = 0;
  let whatsappSent = 0;
  let callSent = 0;

  for (const s of steps) {
    if (s.stepType === "EMAIL") {
      emailSteps++;
      if (s.status === sent || s.status == failed) emailSent++;
    } else if (s.stepType === "SMS") {
      smsSteps++;
      if (s.status === sent || s.status == failed) smsSent++;
    } else if (s.stepType === "WHATSAPP") {
      whatsappSteps++;
      if (s.status === sent || s.status == failed) whatsappSent++;
    } else if (s.stepType === "CALL") {
      callSteps++;
      if (s.status === sent || s.status == failed || s.status === calling) callSent++;
    }
  }

  return { emailSteps, smsSteps, whatsappSteps, callSteps, emailSent, smsSent, whatsappSent, callSent };
};

const getSequences = async (userId: string, status?: string) => {
  const where: Record<string, unknown> = { userId };
  if (status) {
    where.status = status;
  }

  const rows = await prisma.sequence.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      lead: { select: { name: true, email: true, company: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
      _count: { select: { steps: true } },
      steps: { select: { stepType: true, status: true } },
    },
  });

  return rows.map(
    ({ steps: stepRows, _count, ...sequence }) => ({
      ...sequence,
      _count: {
        ..._count,
        ...stepTypeSentCounts(stepRows),
      },
    })
  );
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

const SEQUENCE_INCLUDE = {
  lead: { select: { name: true, email: true, followUpStage: true } },
  promptTemplate: { select: { id: true, name: true, followUpStage: true } },
  steps: { orderBy: { stepOrder: "asc" as const } },
};

const recoverSkippedSteps = async (sequenceId: string) => {
  const skippedSteps = await prisma.sequenceStep.findMany({
    where: {
      sequenceId,
      status: SEQUENCE_STEP_STATUS.SKIPPED,
      // A step that was skipped on request (skip_step) stays skipped.
      OR: [
        { sendLog: null },
        { NOT: { sendLog: { startsWith: SKIPPED_ON_REQUEST } } },
      ],
    },
    select: { id: true, content: true },
  });

  if (skippedSteps.length === 0) return;

  const withContent = skippedSteps
    .filter((s) => s.content)
    .map((s) => s.id);

  const withoutContent = skippedSteps
    .filter((s) => !s.content)
    .map((s) => s.id);

  if (withContent.length > 0) {
    await prisma.sequenceStep.updateMany({
      where: { id: { in: withContent } },
      data: { status: SEQUENCE_STEP_STATUS.DRAFT },
    });
  }

  if (withoutContent.length > 0) {
    await prisma.sequenceStep.updateMany({
      where: { id: { in: withoutContent } },
      data: { status: SEQUENCE_STEP_STATUS.PENDING },
    });
  }
};

const transitionToActive = async (
  sequenceId: string,
  sequence: Awaited<ReturnType<typeof getSequenceById>>,
  actorUserId: string
) => {
  const otherActive = await prisma.sequence.findFirst({
    where: {
      leadId: sequence.leadId,
      userId: sequence.userId,
      status: SEQUENCE_STATUS.ACTIVE,
      id: { not: sequenceId },
    },
  });

  if (otherActive) {
    throw new AppError(
      409,
      "This lead already has another active sequence. Pause or cancel it first."
    );
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

  // AI harness, rule 4: a do-not-contact lead cannot be activated.
  const lead = await prisma.lead.findUnique({
    where: { id: sequence.leadId },
    select: { userId: true, email: true, phone: true, doNotContact: true },
  });

  if (!lead || (await isLeadBlocked(lead))) {
    throw new AppError(400, DO_NOT_CONTACT_MESSAGE);
  }

  await recoverSkippedSteps(sequenceId);

  const pendingSteps = await prisma.sequenceStep.count({
    where: { sequenceId, status: SEQUENCE_STEP_STATUS.PENDING },
  });

  if (pendingSteps > 0) {
    throw new AppError(
      400,
      `${pendingSteps} step(s) have no content. Generate content for all steps before activation.`
    );
  }

  const now = new Date();

  const steps = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
    select: {
      id: true,
      stepOrder: true,
      stepType: true,
      subject: true,
      content: true,
      status: true,
      scheduledAt: true,
      sentAt: true,
      delayMinutes: true,
    },
  });

  // AI harness, rule 8: a sequence made through the harness gets its real
  // send dates now, inside the user's send window. Without a timezone it
  // cannot be approved. Sequences made in the wizard are not affected.
  let plannedDates: Map<string, Date> | null = null;

  if (sequence.runId) {
    const sendWindow = await loadSendWindow(sequence.userId);
    if (!sendWindow.ok) {
      throw new AppError(400, sendWindow.message);
    }
    plannedDates = planSendDates(steps, sendWindow.window, now);
  }

  const pastUnsent = steps.filter((s) => {
    if (
      s.status === SEQUENCE_STEP_STATUS.SENT ||
      s.status === SEQUENCE_STEP_STATUS.FAILED
    ) {
      return false;
    }
    const planned = plannedDates?.get(s.id);
    return planned
      ? planned.getTime() < now.getTime()
      : s.scheduledAt.getTime() <= now.getTime();
  });

  if (pastUnsent.length > 0) {
    const orders = pastUnsent.map((s) => s.stepOrder).join(", ");
    throw new AppError(
      400,
      `Unsent step(s) ${orders} have past scheduled dates. Update them before activation.`
    );
  }

  // AI harness, rule 1: record who released this, when, and exactly what.
  const approvedContentHash = computeApprovalHash({
    leadEmail: lead.email,
    leadPhone: lead.phone,
    steps,
  });

  return prisma.$transaction(
    async (tx) => {
      if (plannedDates) {
        for (const [stepId, scheduledAt] of plannedDates) {
          await tx.sequenceStep.update({
            where: { id: stepId },
            data: { scheduledAt },
          });
        }
      }

      await tx.sequenceStep.updateMany({
        where: { sequenceId, status: SEQUENCE_STEP_STATUS.DRAFT },
        data: { status: SEQUENCE_STEP_STATUS.SCHEDULED },
      });

      const updated = await tx.sequence.update({
        where: { id: sequenceId },
        data: {
          status: SEQUENCE_STATUS.ACTIVE,
          approvalStatus: "approved",
          approvedAt: now,
          approvedByUserId: actorUserId,
          approvedByActor: "user",
          approvedContentHash,
          pausedReason: null,
          pausedAt: null,
        },
        include: SEQUENCE_INCLUDE,
      });

      await syncLeadStatusFromActiveSequences(sequence.leadId, tx);

      // A run that was waiting for a person is complete once its last draft is released.
      if (sequence.runId) {
        await refreshRunAfterApproval(sequence.runId, tx);
      }

      return updated;
    },
    // Same reason as reorderSteps: one update per step over a remote database.
    plannedDates ? { maxWait: 15000, timeout: 60000 } : undefined
  );
};

const transitionToDraft = async (
  sequenceId: string,
  sequence: Awaited<ReturnType<typeof getSequenceById>>
) => {
  return prisma.$transaction(async (tx) => {
    await tx.sequenceStep.updateMany({
      where: {
        sequenceId,
        status: {
          in: [
            SEQUENCE_STEP_STATUS.SCHEDULED,
            SEQUENCE_STEP_STATUS.SENDING,
            SEQUENCE_STEP_STATUS.SKIPPED,
            SEQUENCE_STEP_STATUS.CALLING,
          ],
        },
      },
      data: { status: SEQUENCE_STEP_STATUS.DRAFT },
    });

    const updated = await tx.sequence.update({
      where: { id: sequenceId },
      data: { status: SEQUENCE_STATUS.DRAFT },
      include: SEQUENCE_INCLUDE,
    });

    await syncLeadStatusFromActiveSequences(sequence.leadId, tx);

    return updated;
  });
};

const transitionToCancelled = async (
  sequenceId: string,
  sequence: Awaited<ReturnType<typeof getSequenceById>>
) => {
  return prisma.$transaction(async (tx) => {
    await tx.sequenceStep.updateMany({
      where: {
        sequenceId,
        status: {
          in: [
            SEQUENCE_STEP_STATUS.PENDING,
            SEQUENCE_STEP_STATUS.DRAFT,
            SEQUENCE_STEP_STATUS.SCHEDULED,
            SEQUENCE_STEP_STATUS.SENDING,
            SEQUENCE_STEP_STATUS.CALLING,
          ],
        },
      },
      data: { status: SEQUENCE_STEP_STATUS.SKIPPED },
    });

    const updated = await tx.sequence.update({
      where: { id: sequenceId },
      data: { status: SEQUENCE_STATUS.CANCELLED },
      include: SEQUENCE_INCLUDE,
    });

    await syncLeadStatusFromActiveSequences(sequence.leadId, tx);

    return updated;
  });
};

const transitionSimple = async (
  sequenceId: string,
  sequence: Awaited<ReturnType<typeof getSequenceById>>,
  newStatus: string
) => {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.sequence.update({
      where: { id: sequenceId },
      data:
        newStatus === SEQUENCE_STATUS.PAUSED
          ? {
              status: newStatus,
              pausedReason: "paused_by_user",
              pausedAt: new Date(),
            }
          : { status: newStatus },
      include: SEQUENCE_INCLUDE,
    });

    await syncLeadStatusFromActiveSequences(sequence.leadId, tx);

    return updated;
  });
};

/**
 * `actorUserId` is the logged-in person making the change. Activation is
 * reached only from the REST route (login session), never from the MCP server.
 */
const changeSequenceStatus = async (
  sequenceId: string,
  sequence: Awaited<ReturnType<typeof getSequenceById>>,
  newStatus: string,
  actorUserId: string
) => {
  if (sequence.status === newStatus) {
    throw new AppError(400, `Sequence is already "${newStatus}"`);
  }

  switch (newStatus) {
    case SEQUENCE_STATUS.ACTIVE:
      return transitionToActive(sequenceId, sequence, actorUserId);
    case SEQUENCE_STATUS.DRAFT:
      return transitionToDraft(sequenceId, sequence);
    case SEQUENCE_STATUS.CANCELLED:
      return transitionToCancelled(sequenceId, sequence);
    case SEQUENCE_STATUS.PAUSED:
    case SEQUENCE_STATUS.COMPLETED:
      return transitionSimple(sequenceId, sequence, newStatus);
    default:
      throw new AppError(400, `Invalid status: "${newStatus}"`);
  }
};

const updateSequence = async (
  userId: string,
  sequenceId: string,
  payload: UpdateSequenceInput
) => {
  const sequence = await getSequenceById(userId, sequenceId);

  if (payload.status) {
    const result = await changeSequenceStatus(
      sequenceId,
      sequence,
      payload.status,
      userId
    );
    logActivity({
      sequenceId,
      eventType: "sequence_status_changed",
      actor:     "user",
      meta:      { from: sequence.status, to: payload.status },
    });
    return result;
  }

  // Only these four fields can be edited here, and a lead or a template must
  // belong to the same user. Nothing else from the request reaches the database.
  const data: Prisma.SequenceUncheckedUpdateInput = {};

  if (payload.name !== undefined) data.name = payload.name;
  if (payload.totalSteps !== undefined) data.totalSteps = payload.totalSteps;

  if (payload.leadId !== undefined && payload.leadId !== sequence.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { id: payload.leadId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }
    data.leadId = payload.leadId;
  }

  if (
    payload.promptTemplateId !== undefined &&
    payload.promptTemplateId !== sequence.promptTemplateId
  ) {
    if (payload.promptTemplateId !== null) {
      const template = await prisma.promptTemplate.findFirst({
        where: { id: payload.promptTemplateId, userId },
        select: { id: true },
      });
      if (!template) {
        throw new AppError(404, "Prompt template not found");
      }
    }
    data.promptTemplateId = payload.promptTemplateId;
  }

  const result = await prisma.sequence.update({
    where: { id: sequenceId },
    data,
    include: {
      lead: { select: { name: true, email: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
    },
  });

  logActivity({
    sequenceId,
    eventType: "sequence_edited",
    actor:     "user",
    meta:      { fields: Object.keys(payload) },
  });

  return result;
};

const deleteSequence = async (userId: string, sequenceId: string) => {
  const sequence = await getSequenceById(userId, sequenceId);

  if (sequence.status === SEQUENCE_STATUS.ACTIVE) {
    throw new AppError(
      400,
      "Cannot delete an active sequence. Pause or cancel it first."
    );
  }

  const leadId = sequence.leadId;

  await prisma.sequence.delete({
    where: { id: sequenceId },
  });

  await syncLeadStatusFromActiveSequences(leadId);

  return null;
};

const PLAN_EXTRACTION_PROMPT = (promptText: string, totalSteps: number) => `
Analyze the following follow-up template and return a JSON object with exactly 2 keys:
- "stepTypesPattern": the repeating cycle of step types from the template (e.g. ["EMAIL", "SMS"] or ["EMAIL", "SMS", "WHATSAPP"]). Each value must be one of: ${STEP_TYPE_LIST.join(", ")}. List ONLY one full cycle in order — do NOT repeat entries to match step count.
- "intervalDays": a positive integer for days between consecutive steps.

The sequence has ${totalSteps} total steps. The application will repeat stepTypesPattern cyclically until there are ${totalSteps} steps (e.g. pattern ["EMAIL","SMS"] with ${totalSteps} steps → EMAIL, SMS, EMAIL, SMS, …).

Template:
${promptText}

Return ONLY raw JSON. No explanation, no markdown, no code block.
`.trim();

/** Repeat pattern cyclically until length === totalSteps. */
export const expandStepTypesToTotal = (
  pattern: string[],
  totalSteps: number
): string[] => {
  const result: string[] = [];
  for (let i = 0; i < totalSteps; i++) {
    result.push(pattern[i % pattern.length]);
  }
  return result;
};

const normalizeStepType = (
  value: unknown,
  validTypes: Set<string>
): string => {
  const normalized = String(value).toUpperCase().trim();
  if (!validTypes.has(normalized)) {
    throw new AppError(
      502,
      `AI returned invalid step type "${value}". Allowed: ${STEP_TYPE_LIST.join(", ")}`
    );
  }
  return normalized;
};

const extractPlanFromAI = async (
  provider: string,
  apiKey: string,
  model: string | null | undefined,
  promptText: string,
  totalSteps: number
): Promise<{ stepTypes: string[]; intervalDays: number }> => {
  const prompt = PLAN_EXTRACTION_PROMPT(promptText, totalSteps);

  const aiResponse = await generateContent(
    {
      provider: provider as AIProvider,
      apiKey,
      model: model || undefined,
    },
    prompt
  );

  const raw = aiResponse.content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      502,
      "AI returned an invalid plan. Please try again or adjust your prompt template."
    );
  }

  const record = parsed as Record<string, unknown>;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof record.intervalDays !== "number"
  ) {
    throw new AppError(
      502,
      "AI plan response is missing required fields (stepTypesPattern, intervalDays)."
    );
  }

  const rawPattern = record.stepTypesPattern ?? record.stepTypes;
  if (!Array.isArray(rawPattern) || rawPattern.length === 0) {
    throw new AppError(
      502,
      "AI plan response must include a non-empty stepTypesPattern array."
    );
  }

  const validTypes = new Set<string>(STEP_TYPE_LIST);
  const cycle = rawPattern.map((t) => normalizeStepType(t, validTypes));

  const stepTypes =
    cycle.length === totalSteps
      ? cycle
      : expandStepTypesToTotal(cycle, totalSteps);


  const intervalDays = Math.round(record.intervalDays as number);
  if (intervalDays < 1) {
    throw new AppError(502, "AI returned an invalid intervalDays (must be >= 1).");
  }

  return { stepTypes, intervalDays };
};

const generateSteps = async (userId: string, sequenceId: string) => {
  // 1. Load sequence with all relations
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, userId },
    include: {
      lead: true,
      promptTemplate: true,
      steps: { orderBy: { stepOrder: "asc" } },
    },
  });


  if (!sequence) throw new AppError(404, "Sequence not found");
  assertDraftOrPaused(sequence.status, "generate steps");
  if (!sequence.promptTemplate) {
    throw new AppError(
      400,
      "No prompt template linked. Assign a prompt template first."
    );
  }

  // 2. Check AI settings upfront
  const aiSettings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { aiProvider: true, aiModel: true },
  });
  const aiApiKey = await SettingsService.getDecryptedField(userId, "aiApiKey");

  if (!aiSettings?.aiProvider || !aiApiKey) {
    throw new AppError(
      400,
      "AI provider and API key not configured. Please set them in Settings."
    );
  }

  // 3. Extract plan from AI (stepTypes + intervalDays)
  const { stepTypes, intervalDays } = await extractPlanFromAI(
    aiSettings.aiProvider,
    aiApiKey,
    aiSettings.aiModel,
    sequence.promptTemplate.promptText,
    sequence.totalSteps
  );


  // 4. Determine which steps are missing
  const existingOrders = new Set(sequence.steps.map((s) => s.stepOrder));
  const missingOrders = Array.from(
    { length: sequence.totalSteps },
    (_, i) => i + 1
  ).filter((order) => !existingOrders.has(order));


  // 5. Calculate startDate for new steps
  //    If existing steps present, base off last one; otherwise now + 6h
  let baseDate: Date;
  if (sequence.steps.length > 0) {
    const lastStep = sequence.steps[sequence.steps.length - 1];
    baseDate = new Date(lastStep.scheduledAt);
  } else {
    baseDate = new Date();
    baseDate.setHours(baseDate.getHours() + 6);
  }


  // 6. Create missing steps
  if (missingOrders.length > 0) {
    const newSteps = missingOrders.map((order) => {
      const scheduledAt = new Date(baseDate);
      // offset from base by how many positions away this order is from the last existing step
      const offset = sequence.steps.length > 0
        ? order - sequence.steps[sequence.steps.length - 1].stepOrder
        : order - 1;
      scheduledAt.setDate(scheduledAt.getDate() + offset * intervalDays);

      return {
        sequenceId,
        stepOrder: order,
        stepType: stepTypes[order - 1],
        scheduledAt,
      };
    });
    await prisma.sequenceStep.createMany({ data: newSteps });
  }

  // 7. Reload all steps after creation
  const allSteps = await prisma.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
  });

  // 8. Generate content for all pending steps sequentially
  const results: { stepOrder: number; status: string; error?: string }[] = [];

  for (const step of allSteps) {
    if (step.status !== SEQUENCE_STEP_STATUS.PENDING) {
      results.push({
        stepOrder: step.stepOrder,
        status: SEQUENCE_STEP_STATUS.SKIPPED,
      });
      continue;
    }

    try {
      const previousSteps = await prisma.sequenceStep.findMany({
        where: {
          sequenceId,
          stepOrder: { lt: step.stepOrder },
          status: { not: SEQUENCE_STEP_STATUS.PENDING },
        },
        orderBy: { stepOrder: "asc" },
        select: { stepOrder: true, stepType: true, subject: true, content: true },
      });

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


      const prompt = buildPrompt({
        promptText: sequence.promptTemplate!.promptText,
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

      const aiResponse = await generateContent(
        {
          provider: aiSettings.aiProvider as AIProvider,
          apiKey: aiApiKey,
          model: aiSettings.aiModel || undefined,
        },
        prompt
      );


      const parsedContent = parseAIResponse(aiResponse.content, step.stepType);


      await prisma.sequenceStep.update({
        where: { id: step.id },
        data: {
          subject: parsedContent.subject,
          content: parsedContent.content,
          status: SEQUENCE_STEP_STATUS.DRAFT,
        },
      });

      results.push({ stepOrder: step.stepOrder, status: "generated" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({
        stepOrder: step.stepOrder,
        status: SEQUENCE_STEP_STATUS.FAILED,
        error: message,
      });
    }
  }

  // 9. Return updated sequence with steps
  const updatedSequence = await prisma.sequence.findFirst({
    where: { id: sequenceId },
    include: {
      lead: { select: { name: true, email: true, followUpStage: true } },
      promptTemplate: { select: { id: true, name: true, followUpStage: true } },
      steps: { orderBy: { stepOrder: "asc" } },
    },
  });

  return {
    sequence: updatedSequence,
    generationResults: results,
  };
};

// --- Wizard generation ---

const CHANNEL_TO_STEP_TYPE: Record<string, string> = {
  email:    "EMAIL",
  sms:      "SMS",
  whatsapp: "WHATSAPP",
  aicall:   "CALL",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Spread N steps evenly across M days: gaps = N-1, so interval can be fractional. */
const cadenceIntervalDays = (totalSteps: number, totalDays: number): number =>
  totalDays / Math.max(totalSteps - 1, 1);

const addDaysPrecise = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * MS_PER_DAY);

type AiConfig        = { provider: AIProvider; apiKey: string; model: string | undefined };
type StepRow         = { id: string; stepOrder: number; stepType: string };
type WizardContext   = {
  promptText: string;
  goal: string;
  tone: string;
  intensity: string;
  totalSteps: number;
  sequenceName?: string;
};
type GenerationResult = { stepOrder: number; status: string; error?: string };

const runGenerationLoop = async (
  sequenceId: string,
  leadId:     string,
  userId:     string,
  steps:      StepRow[],
  wizard:     WizardContext,
  aiConfig:   AiConfig
): Promise<GenerationResult[]> => {
  const results: GenerationResult[] = [];

  const lead = await prisma.lead.findFirst({
    where:  { id: leadId },
    select: { name: true, email: true, phone: true, company: true, location: true, followUpStage: true, notes: true },
  });
  if (!lead) throw new AppError(404, "Lead not found");

  const transcripts = await prisma.leadTranscript.findMany({
    where:   { leadId, userId },
    orderBy: { meetingDate: "desc" },
    select:  { transcript: true },
    take:    3,
  });
  const transcriptText =
    transcripts.length > 0 ? transcripts.map((t) => t.transcript).join("\n\n---\n\n") : null;

  for (const step of steps) {
    try {
      const previousSteps = await prisma.sequenceStep.findMany({
        where:   { sequenceId, stepOrder: { lt: step.stepOrder }, status: { not: SEQUENCE_STEP_STATUS.PENDING } },
        orderBy: { stepOrder: "asc" },
        select:  { stepOrder: true, stepType: true, subject: true, content: true },
      });

      const prompt = buildWizardStepPrompt({
        promptText: wizard.promptText,
        goal:      wizard.goal,
        tone:      wizard.tone      as Parameters<typeof buildWizardStepPrompt>[0]["tone"],
        intensity: wizard.intensity as Parameters<typeof buildWizardStepPrompt>[0]["intensity"],
        stepContext: { stepOrder: step.stepOrder, totalSteps: wizard.totalSteps, stepType: step.stepType },
        previousSteps,
        lead,
        transcript: transcriptText,
        sequenceName: wizard.sequenceName,
      });

      const aiResponse = await generateContent(
        { provider: aiConfig.provider, apiKey: aiConfig.apiKey, model: aiConfig.model },
        prompt
      );

      const parsed = parseAIResponse(aiResponse.content, step.stepType);

      await prisma.sequenceStep.update({
        where: { id: step.id },
        data:  { subject: parsed.subject, content: parsed.content, status: SEQUENCE_STEP_STATUS.DRAFT },
      });

      results.push({ stepOrder: step.stepOrder, status: "generated" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      results.push({ stepOrder: step.stepOrder, status: SEQUENCE_STEP_STATUS.FAILED, error: message });
    }
  }

  return results;
};

export type GenerateSaveOptions = {
  /** Skip the "one active sequence per lead" check on the create path (used by AutoDraft). */
  allowWhileActive?: boolean;
  /** Actor recorded in the activity log. Defaults to "user". */
  actor?: "user" | "system";
};

const generateAndSave = async (
  userId: string,
  payload: GenerateSaveInput,
  options: GenerateSaveOptions = {}
) => {
  const { sequenceId, leadId, promptTemplateId, goal, preferences } = payload;
  const { tone, intensity, cadence, channels } = preferences;
  const actor = options.actor ?? "user";

  // --- EDIT / REBUILD PATH (sequenceId present) ---
  // Update wizard fields (incl. leadId) from body → delete all steps → recreate → generate content.
  // Status stays draft/paused — never activated here.
  if (sequenceId) {
    const sequence = await prisma.sequence.findFirst({
      where: { id: sequenceId, userId },
    });

    if (!sequence) throw new AppError(404, "Sequence not found");

    if (!sequence.goal || !sequence.tone || !sequence.intensity || !sequence.cadence || !sequence.channels) {
      throw new AppError(400, "This sequence was not created via the wizard and cannot use generate-save rebuild.");
    }

    assertDraftOrPaused(sequence.status, "rebuild this sequence");

    const lead = await prisma.lead.findFirst({ where: { id: leadId, userId, deletedAt: null } });
    if (!lead) throw new AppError(404, "Lead not found");

    const promptTemplate = await prisma.promptTemplate.findFirst({
      where: { id: promptTemplateId, userId },
    });
    if (!promptTemplate) throw new AppError(404, "Prompt template not found");

    const aiSettings = await prisma.userSettings.findUnique({ where: { userId }, select: { aiProvider: true, aiModel: true } });
    const aiApiKey   = await SettingsService.getDecryptedField(userId, "aiApiKey");
    if (!aiSettings?.aiProvider || !aiApiKey) {
      throw new AppError(400, "AI provider and API key not configured. Please set them in Settings.");
    }

    const cadenceRaw   = cadence as string;
    const cadenceMatch = CADENCE_REGEX.exec(cadenceRaw)!;
    const totalSteps   = parseInt(cadenceMatch[1], 10);
    const totalDays    = parseInt(cadenceMatch[2], 10);
    const intervalDays = cadenceIntervalDays(totalSteps, totalDays);
    const stepTypes    = expandStepTypesToTotal(
      channels.map((c) => CHANNEL_TO_STEP_TYPE[c]),
      totalSteps
    );

    const baseDate = new Date();
    baseDate.setHours(baseDate.getHours() + 6);

    const stepSchedules = Array.from({ length: totalSteps }, (_, i) => ({
      order: i + 1,
      stepType: stepTypes[i],
      scheduledAt: addDaysPrecise(baseDate, i * intervalDays),
    }));

    const previousLeadId = sequence.leadId;
    const sequenceName = `${lead.name} — ${goal}`;

    // Sequential (no interactive $transaction): avoids Prisma's 5s interactive-tx timeout on slow Supabase.
    await prisma.sequenceStep.deleteMany({ where: { sequenceId: sequence.id } });

    await prisma.sequence.update({
      where: { id: sequence.id },
      data: {
        leadId: lead.id,
        promptTemplateId: promptTemplate.id,
        name: sequenceName,
        totalSteps,
        goal,
        tone,
        intensity,
        cadence: cadenceRaw,
        channels,
      },
    });

    await prisma.sequenceStep.createMany({
      data: stepSchedules.map((s) => ({
        sequenceId: sequence.id,
        stepOrder: s.order,
        stepType: s.stepType,
        scheduledAt: s.scheduledAt,
      })),
    });

    if (previousLeadId !== lead.id) {
      await syncLeadStatusFromActiveSequences(previousLeadId);
      await syncLeadStatusFromActiveSequences(lead.id);
    }

    const rebuilt = await prisma.sequence.findFirst({
      where: { id: sequence.id },
      include: { lead: true, steps: { orderBy: { stepOrder: "asc" } } },
    });
    if (!rebuilt) throw new AppError(404, "Sequence not found after rebuild");

    const generationResults = await runGenerationLoop(
      rebuilt.id,
      rebuilt.leadId,
      userId,
      rebuilt.steps,
      {
        promptText: promptTemplate.promptText,
        goal,
        tone,
        intensity,
        totalSteps,
        sequenceName,
      },
      {
        provider: aiSettings.aiProvider as AIProvider,
        apiKey: aiApiKey,
        model: aiSettings.aiModel ?? undefined,
      }
    );

    const updatedSequence = await prisma.sequence.findFirst({
      where:   { id: rebuilt.id },
      include: {
        lead: { select: { name: true, email: true, followUpStage: true } },
        promptTemplate: { select: { id: true, name: true, followUpStage: true } },
        steps: { orderBy: { stepOrder: "asc" } },
      },
    });

    logActivity({
      sequenceId: rebuilt.id,
      eventType:  "sequence_generated",
      actor:      "user",
      meta:       {
        promptTemplateId: promptTemplate.id,
        goal,
        tone,
        intensity,
        cadence: cadenceRaw,
        totalSteps,
        rebuilt: true,
        stepsGenerated: generationResults.filter((r) => r.status === "generated").length,
      },
    });

    return { sequence: updatedSequence, generationResults };
  }

  // --- CREATE PATH ---
  const lead = await prisma.lead.findFirst({ where: { id: leadId, userId, deletedAt: null } });
  if (!lead) throw new AppError(404, "Lead not found");

  const promptTemplate = await prisma.promptTemplate.findFirst({
    where: { id: promptTemplateId, userId },
  });
  if (!promptTemplate) throw new AppError(404, "Prompt template not found");

  if (!options.allowWhileActive) {
    const activeSeq = await prisma.sequence.findFirst({ where: { leadId, userId, status: SEQUENCE_STATUS.ACTIVE } });
    if (activeSeq) throw new AppError(409, "This lead already has an active sequence. Pause or cancel it first.");
  }

  const aiSettings = await prisma.userSettings.findUnique({ where: { userId }, select: { aiProvider: true, aiModel: true } });
  const aiApiKey   = await SettingsService.getDecryptedField(userId, "aiApiKey");
  if (!aiSettings?.aiProvider || !aiApiKey) throw new AppError(400, "AI provider and API key not configured. Please set them in Settings.");

  const cadenceRaw    = cadence as string;
  const cadenceMatch  = CADENCE_REGEX.exec(cadenceRaw)!;
  const totalSteps    = parseInt(cadenceMatch[1], 10);
  const totalDays     = parseInt(cadenceMatch[2], 10);
  const intervalDays  = cadenceIntervalDays(totalSteps, totalDays);
  const stepTypes     = expandStepTypesToTotal(channels.map((c) => CHANNEL_TO_STEP_TYPE[c]), totalSteps);

  const baseDate = new Date();
  baseDate.setHours(baseDate.getHours() + 6);

  const stepSchedules = Array.from({ length: totalSteps }, (_, i) => ({
    order: i + 1,
    stepType: stepTypes[i],
    scheduledAt: addDaysPrecise(baseDate, i * intervalDays),
  }));

  const sequenceName = `${lead.name} — ${goal}`;

  const sequence = await prisma.$transaction(async (tx) => {
    const created = await tx.sequence.create({
      data: {
        userId,
        leadId,
        promptTemplateId: promptTemplate.id,
        name: sequenceName,
        totalSteps,
        goal,
        tone,
        intensity,
        cadence: cadenceRaw,
        channels,
        steps: {
          createMany: {
            data: stepSchedules.map((s) => ({
              stepOrder: s.order,
              stepType: s.stepType,
              scheduledAt: s.scheduledAt,
            })),
          },
        },
      },
      include: { lead: true, steps: { orderBy: { stepOrder: "asc" } } },
    });
    await syncLeadStatusFromActiveSequences(leadId, tx);
    return created;
  });

  const generationResults = await runGenerationLoop(
    sequence.id, leadId, userId, sequence.steps,
    {
      promptText: promptTemplate.promptText,
      goal,
      tone,
      intensity,
      totalSteps,
      sequenceName,
    },
    { provider: aiSettings.aiProvider as AIProvider, apiKey: aiApiKey, model: aiSettings.aiModel ?? undefined }
  );

  const updatedSequence = await prisma.sequence.findFirst({
    where:   { id: sequence.id },
    include: { lead: { select: { name: true, email: true, followUpStage: true } }, promptTemplate: { select: { id: true, name: true, followUpStage: true } }, steps: { orderBy: { stepOrder: "asc" } } },
  });

  logActivity({
    sequenceId: sequence.id,
    eventType:  "sequence_generated",
    actor,
    meta:       {
      promptTemplateId: promptTemplate.id,
      goal,
      tone,
      intensity,
      cadence: cadenceRaw,
      totalSteps,
      stepsGenerated: generationResults.filter((r) => r.status === "generated").length,
    },
  });

  return { sequence: updatedSequence, generationResults };
};

const regenerateSteps = async (userId: string, sequenceId: string) => {
  const sequence = await prisma.sequence.findFirst({
    where:   { id: sequenceId, userId },
    include: {
      steps: { orderBy: { stepOrder: "asc" } },
      promptTemplate: { select: { id: true, name: true, promptText: true } },
    },
  });

  if (!sequence) throw new AppError(404, "Sequence not found");

  if (!sequence.promptTemplateId || !sequence.promptTemplate || !sequence.goal || !sequence.tone || !sequence.intensity) {
    throw new AppError(400, "This sequence was not created via the wizard and cannot use regenerate-steps.");
  }

  assertDraftOrPaused(sequence.status, "regenerate steps");

  const aiSettings = await prisma.userSettings.findUnique({ where: { userId }, select: { aiProvider: true, aiModel: true } });
  const aiApiKey   = await SettingsService.getDecryptedField(userId, "aiApiKey");
  if (!aiSettings?.aiProvider || !aiApiKey) throw new AppError(400, "AI provider and API key not configured. Please set them in Settings.");

  await prisma.sequenceStep.updateMany({
    where: { sequenceId },
    data:  { subject: null, content: null, status: SEQUENCE_STEP_STATUS.PENDING },
  });

  const freshSteps = await prisma.sequenceStep.findMany({
    where:   { sequenceId },
    orderBy: { stepOrder: "asc" },
    select:  { id: true, stepOrder: true, stepType: true },
  });

  const generationResults = await runGenerationLoop(
    sequence.id, sequence.leadId, userId, freshSteps,
    {
      promptText: sequence.promptTemplate.promptText,
      goal: sequence.goal,
      tone: sequence.tone,
      intensity: sequence.intensity,
      totalSteps: sequence.totalSteps,
      sequenceName: sequence.name,
    },
    { provider: aiSettings.aiProvider as AIProvider, apiKey: aiApiKey, model: aiSettings.aiModel ?? undefined }
  );

  const updatedSequence = await prisma.sequence.findFirst({
    where:   { id: sequenceId },
    include: { lead: { select: { name: true, email: true, followUpStage: true } }, promptTemplate: { select: { id: true, name: true, followUpStage: true } }, steps: { orderBy: { stepOrder: "asc" } } },
  });

  logActivity({
    sequenceId,
    eventType: "sequence_regenerated",
    actor:     "user",
    meta:      { stepsReset: freshSteps.length, stepsGenerated: generationResults.filter((r) => r.status === "generated").length },
  });

  return { sequence: updatedSequence, generationResults };
};

const getActivity = async (
  userId: string,
  sequenceId: string,
  page: number,
  limit: number
) => {
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, userId },
    select: { id: true },
  });
  if (!sequence) throw new AppError(404, "Sequence not found");

  const [items, total] = await Promise.all([
    prisma.sequenceActivity.findMany({
      where:   { sequenceId },
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * limit,
      take:    limit,
    }),
    prisma.sequenceActivity.count({ where: { sequenceId } }),
  ]);

  return { items, total, page, limit };
};

export const SequenceService = {
  createSequence,
  getSequences,
  getSequenceById,
  updateSequence,
  deleteSequence,
  generateSteps,
  generateAndSave,
  regenerateSteps,
  getActivity,
};

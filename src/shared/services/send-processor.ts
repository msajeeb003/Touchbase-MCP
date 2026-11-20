import cron from "node-cron";
import prisma from "../prisma";
import { SEQUENCE_STEP_STATUS } from "../sequence-step";
import { syncLeadStatusFromActiveSequences } from "../../modules/lead/lead.service";
import { sendEmail } from "./email.service";
import { sendSms } from "./sms.service";
import { sendWhatsApp } from "./whatsapp.service";
import { triggerCall } from "./calling.service";
import { logActivity } from "./activity-logger";
import config from "../../config";
import { type DeliveryMode, outboundMode } from "../../harness/switches";
import { isLeadBlocked } from "../../harness/do-not-contact";
import { checkApprovedForSend } from "../../harness/approval";
import { pauseSequenceBySystem } from "../../harness/pause";
import {
  isInsideSendWindow,
  loadSendWindow,
  nextAllowedTime,
} from "../../harness/send-window";

const BATCH_SIZE = config.batch_size;

/** A step claimed for sending that shows no result after this long is given up. */
export const STALE_SENDING_MINUTES = 15;

/** With no timezone set, a waiting step is looked at again after this long. */
const NO_TIMEZONE_RECHECK_MINUTES = 30;

const INTERRUPTED_LOG =
  "Failed: interrupted. The send was started but its result was never recorded. " +
  "It was not tried again, to avoid sending the same message twice.";

const DO_NOT_CONTACT_LOG = "Not sent: this lead is marked do-not-contact.";

/** The four provider calls. Tests pass their own, so nothing real is contacted. */
export type Senders = {
  sendEmail: typeof sendEmail;
  sendSms: typeof sendSms;
  sendWhatsApp: typeof sendWhatsApp;
  triggerCall: typeof triggerCall;
};

const defaultSenders: Senders = { sendEmail, sendSms, sendWhatsApp, triggerCall };

type StepToSend = {
  id: string;
  stepType: string;
  subject: string | null;
  content: string | null;
  sequence: {
    id: string;
    userId: string;
    lead: {
      name: string;
      email: string | null;
      phone: string | null;
      company: string | null;
    };
  };
};

type StepResult = {
  success: boolean;
  log: string;
  deliveryMode: DeliveryMode;
  async?: boolean;
  externalMessageId?: string;
  whatsappPending?: boolean;
};

const mockLog = (what: string, to: string) =>
  `MOCK: ${what} to ${to} was not sent (OUTBOUND_MODE=mock)`;

const processStep = async (
  step: StepToSend,
  senders: Senders
): Promise<StepResult> => {
  const mode = outboundMode();

  if (!step.content) {
    return { success: false, log: "Failed: Step has no content", deliveryMode: mode };
  }

  try {
    if (step.stepType === "EMAIL") {
      if (!step.sequence.lead.email) {
        return {
          success: false,
          log: "Failed: Lead has no email address",
          deliveryMode: mode,
        };
      }

      const sent = await senders.sendEmail(step.sequence.userId, {
        to: step.sequence.lead.email,
        subject: step.subject || "(No Subject)",
        text: step.content,
      });
      const deliveryMode = sent?.deliveryMode ?? mode;

      return {
        success: true,
        deliveryMode,
        log:
          deliveryMode === "mock"
            ? mockLog("email", step.sequence.lead.email)
            : `Email sent to ${step.sequence.lead.email}`,
      };
    } else if (step.stepType === "SMS") {
      if (!step.sequence.lead.phone) {
        return {
          success: false,
          log: "Failed: Lead has no phone number",
          deliveryMode: mode,
        };
      }

      const sent = await senders.sendSms(
        step.sequence.userId,
        step.sequence.lead.phone,
        step.content
      );
      const deliveryMode = sent?.deliveryMode ?? mode;

      return {
        success: true,
        deliveryMode,
        log:
          deliveryMode === "mock"
            ? mockLog("SMS", step.sequence.lead.phone)
            : `SMS sent to ${step.sequence.lead.phone}`,
      };
    } else if (step.stepType === "WHATSAPP") {
      if (!step.sequence.lead.phone) {
        return {
          success: false,
          log: "Failed: Lead has no phone number",
          deliveryMode: mode,
        };
      }

      const waResult = await senders.sendWhatsApp(
        step.sequence.userId,
        step.sequence.lead.phone,
        step.content
      );

      if (waResult.mock) {
        return {
          success: true,
          deliveryMode: "mock",
          log: mockLog("WhatsApp message", step.sequence.lead.phone),
        };
      }

      if (waResult.mode === "webhook") {
        return {
          success: true,
          async: true,
          whatsappPending: true,
          deliveryMode: "live",
          externalMessageId: waResult.sid,
          log: `WhatsApp queued at Twilio (sid: ${waResult.sid}) — awaiting delivery status`,
        };
      }

      return {
        success: true,
        deliveryMode: "live",
        log: `WhatsApp accepted by Twilio (sid: ${waResult.sid}, status: ${waResult.status}) — set PUBLIC_BASE_URL for delivery tracking`,
      };
    } else if (step.stepType === "CALL") {
      if (!step.sequence.lead.phone) {
        return {
          success: false,
          log: "Failed: Lead has no phone number",
          deliveryMode: mode,
        };
      }

      const result = await senders.triggerCall({
        userId: step.sequence.userId,
        stepId: step.id,
        sequenceId: step.sequence.id,
        phone: step.sequence.lead.phone,
        agentPrompt: step.content,
      });

      if (result.mock) {
        return {
          success: true,
          deliveryMode: "mock",
          log: `MOCK: call to ${step.sequence.lead.phone} was not placed (OUTBOUND_MODE=mock)`,
        };
      }

      return {
        success: true,
        async: true,
        deliveryMode: "live",
        log: `Call initiated (retellCallId: ${result.callId})`,
      };
    }

    return { success: false, log: "Failed: Unknown step type", deliveryMode: mode };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";
    return { success: false, log: `Failed: ${message}`, deliveryMode: mode };
  }
};

const checkSequenceCompletion = async (sequenceId: string) => {
  const remaining = await prisma.sequenceStep.count({
    where: {
      sequenceId,
      status: {
        in: [
          SEQUENCE_STEP_STATUS.SCHEDULED,
          SEQUENCE_STEP_STATUS.SENDING,
          SEQUENCE_STEP_STATUS.CALLING,
        ],
      },
    },
  });

  if (remaining === 0) {
    const seq = await prisma.sequence.findUnique({
      where: { id: sequenceId },
      select: { leadId: true },
    });

    await prisma.sequence.update({
      where: { id: sequenceId },
      data: { status: "completed" },
    });

    if (seq) {
      await syncLeadStatusFromActiveSequences(seq.leadId);
    }

    // console.log(`[SendProcessor] Sequence ${sequenceId} completed`);
  }
};

/**
 * A step that was claimed for sending but shows no result after 15 minutes
 * (the server stopped in the middle) is marked failed. It is NOT sent again:
 * the message may already have gone out, and a duplicate is worse than a gap.
 *
 * A WhatsApp step that is waiting for Twilio's delivery report has an
 * external message id and is left alone.
 */
export const failInterruptedSends = async (now: Date): Promise<string[]> => {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MINUTES * 60_000);

  const stuck = await prisma.sequenceStep.findMany({
    where: {
      status: SEQUENCE_STEP_STATUS.SENDING,
      sendingStartedAt: { lt: cutoff },
      externalMessageId: null,
    },
    select: { id: true, sequenceId: true, stepOrder: true, stepType: true },
    take: 100,
  });

  const sequenceIds: string[] = [];

  for (const step of stuck) {
    const failed = await prisma.sequenceStep.updateMany({
      where: {
        id: step.id,
        status: SEQUENCE_STEP_STATUS.SENDING,
        externalMessageId: null,
      },
      data: { status: SEQUENCE_STEP_STATUS.FAILED, sendLog: INTERRUPTED_LOG },
    });

    if (failed.count !== 1) continue;

    await logActivity({
      sequenceId: step.sequenceId,
      stepId: step.id,
      eventType: "step_failed",
      actor: "system",
      meta: {
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        reason: INTERRUPTED_LOG,
      },
    });
    console.log(`[SendProcessor] Step ${step.id}: ${INTERRUPTED_LOG}`);
    sequenceIds.push(step.sequenceId);
  }

  return sequenceIds;
};

/**
 * Moves a waiting step to a later date and keeps the spacing of the steps
 * after it. The step stays "scheduled".
 *
 * The move only happens if the step still has the date this pass read. When
 * two passes overlap, the second one finds the date already changed and does
 * nothing, so the later steps are never shifted twice.
 */
const deferStep = async (
  step: { id: string; sequenceId: string; stepOrder: number; scheduledAt: Date },
  newDate: Date,
  note: string
): Promise<boolean> => {
  const shiftMs = newDate.getTime() - step.scheduledAt.getTime();

  const moved = await prisma.sequenceStep.updateMany({
    where: {
      id: step.id,
      status: SEQUENCE_STEP_STATUS.SCHEDULED,
      scheduledAt: step.scheduledAt,
    },
    data: { scheduledAt: newDate, sendLog: note },
  });

  if (moved.count !== 1) return false;
  if (shiftMs <= 0) return true;

  await prisma.$executeRaw`
    UPDATE sequence_steps
    SET "scheduledAt" = "scheduledAt" + (${shiftMs}::double precision * interval '1 millisecond')
    WHERE "sequenceId" = ${step.sequenceId}
      AND "stepOrder" > ${step.stepOrder}
      AND "status" = ${SEQUENCE_STEP_STATUS.SCHEDULED}
  `;
  return true;
};

/** What one pass did. Returned by the send-job endpoint and logged. */
export type SendTickSummary = {
  /** due steps looked at in this pass */
  due: number;
  /** sent for real (live mode) */
  sent: number;
  /** recorded as a mock send (mock mode): marked sent, nothing left the server */
  mock: number;
  /** handed to a provider that reports back later (WhatsApp, calls) */
  pending: number;
  /** the provider refused or the step could not be sent: marked failed */
  failed: number;
  /** outside the send window, or no timezone: moved to a later time */
  waiting: number;
  /** held back on purpose: do-not-contact, not approved, changed after approval */
  held: number;
  /** taken by another pass at the same moment, or paused meanwhile */
  skipped: number;
  /** stuck in "sending" from an earlier pass: marked failed, not sent again */
  interrupted: number;
  /** unexpected errors (database, code). Each is logged with its step id. */
  errors: number;
  errorMessages: string[];
};

type DueStep = {
  id: string;
  sequenceId: string;
  stepOrder: number;
  stepType: string;
  scheduledAt: Date;
};

type Outcome = "sent" | "mock" | "pending" | "failed" | "waiting" | "held" | "skipped";

/**
 * Order of the checks for one due step:
 *  1. the sequence is still active;
 *  2. the lead is not do-not-contact (all four channels);
 *  3. for a sequence made through the harness: inside the user's send window
 *     (email and SMS);
 *  4. CLAIM: the step is moved "scheduled" -> "sending" with a conditional
 *     update. Only the caller whose update changed exactly one row goes on,
 *     so two passes can never send the same step;
 *  5. for a sequence made through the harness: a person approved it and
 *     nothing was changed since (checked on the content that is about to go out);
 *  6. send, then record the result.
 */
const handleDueStep = async (
  step: DueStep,
  now: Date,
  senders: Senders
): Promise<Outcome> => {
  // 1. fresh look at the sequence and the lead
  const sequence = await prisma.sequence.findUnique({
    where: { id: step.sequenceId },
    select: {
      id: true,
      userId: true,
      status: true,
      runId: true,
      approvalStatus: true,
      approvedAt: true,
      approvedByUserId: true,
      approvedContentHash: true,
      lead: {
        select: {
          userId: true,
          name: true,
          email: true,
          phone: true,
          company: true,
          doNotContact: true,
        },
      },
    },
  });

  if (sequence?.status !== "active") return "skipped";

  // 2. do-not-contact: nothing goes out on any channel
  if (await isLeadBlocked(sequence.lead)) {
    await prisma.sequenceStep.updateMany({
      where: { id: step.id, status: SEQUENCE_STEP_STATUS.SCHEDULED },
      data: { sendLog: DO_NOT_CONTACT_LOG },
    });
    await pauseSequenceBySystem(sequence.id, "do_not_contact");
    console.log(`[SendProcessor] Step ${step.id}: ${DO_NOT_CONTACT_LOG}`);
    return "held";
  }

  const isHarnessSequence = sequence.runId !== null;

  // 3. send window (harness sequences, email and SMS). A step whose time has
  // passed is caught up on the first pass inside the window; outside it, the
  // step is moved to the moment the window next opens.
  if (isHarnessSequence && (step.stepType === "EMAIL" || step.stepType === "SMS")) {
    const sendWindow = await loadSendWindow(sequence.userId);

    if (!sendWindow.ok) {
      const moved = await deferStep(
        step,
        new Date(now.getTime() + NO_TIMEZONE_RECHECK_MINUTES * 60_000),
        `Waiting: ${sendWindow.message}`
      );
      return moved ? "waiting" : "skipped";
    }

    if (!isInsideSendWindow(now, sendWindow.window)) {
      const opensAt = nextAllowedTime(now, sendWindow.window);
      const moved = await deferStep(
        step,
        opensAt,
        `Waiting for the send window. Moved to ${opensAt.toISOString()}.`
      );
      if (moved) {
        console.log(`[SendProcessor] Step ${step.id}: outside the send window, moved to ${opensAt.toISOString()}`);
      }
      return moved ? "waiting" : "skipped";
    }
  }

  // 4. claim before send
  const claimed = await prisma.sequenceStep.updateMany({
    where: {
      id: step.id,
      status: SEQUENCE_STEP_STATUS.SCHEDULED,
      sequence: { status: "active" },
    },
    data: {
      status: SEQUENCE_STEP_STATUS.SENDING,
      sendingStartedAt: new Date(),
      deliveryMode: outboundMode(),
    },
  });

  // another pass took it, or it was paused or edited in the meantime
  if (claimed.count !== 1) return "skipped";

  // the text that will go out, read after the claim
  const content = await prisma.sequenceStep.findUnique({
    where: { id: step.id },
    select: { subject: true, content: true, stepType: true },
  });

  // 5. approval record (harness sequences)
  const approval = await checkApprovedForSend(sequence);

  if (!content || !approval.ok) {
    await prisma.sequenceStep.updateMany({
      where: { id: step.id, status: SEQUENCE_STEP_STATUS.SENDING },
      data: {
        status: SEQUENCE_STEP_STATUS.SCHEDULED,
        sendingStartedAt: null,
        deliveryMode: null,
        sendLog: approval.ok
          ? null
          : approval.reason === "not_approved"
            ? "Not sent: this sequence has not been approved by a person."
            : "Not sent: the messages or the recipient changed after approval. A person must approve again.",
      },
    });
    if (!approval.ok) {
      await pauseSequenceBySystem(sequence.id, approval.reason);
      console.log(
        `[SendProcessor] Step ${step.id} not sent (${approval.reason}); sequence paused`
      );
    }
    return "held";
  }

  // 6. send
  const result = await processStep(
    {
      id: step.id,
      stepType: content.stepType,
      subject: content.subject,
      content: content.content,
      sequence: { id: sequence.id, userId: sequence.userId, lead: sequence.lead },
    },
    senders
  );

  if (result.success && result.async) {
    await prisma.sequenceStep.update({
      where: { id: step.id },
      data: {
        status: result.whatsappPending
          ? SEQUENCE_STEP_STATUS.SENDING
          : SEQUENCE_STEP_STATUS.CALLING,
        sendLog: result.log,
        deliveryMode: result.deliveryMode,
        ...(result.externalMessageId && { externalMessageId: result.externalMessageId }),
      },
    });
    await logActivity({
      sequenceId: step.sequenceId,
      stepId: step.id,
      eventType: "step_sending",
      actor: "system",
      meta: {
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        externalMessageId: result.externalMessageId ?? null,
      },
    });
    console.log(`[SendProcessor] ${result.log}`);
    return "pending";
  }

  if (result.success) {
    const sentAt = new Date();
    await prisma.sequenceStep.update({
      where: { id: step.id },
      data: {
        status: SEQUENCE_STEP_STATUS.SENT,
        sentAt,
        sendLog: result.log,
        deliveryMode: result.deliveryMode,
      },
    });
    await logActivity({
      sequenceId: step.sequenceId,
      stepId: step.id,
      eventType: "step_sent",
      actor: "system",
      meta: {
        stepOrder: step.stepOrder,
        stepType: step.stepType,
        sentAt: sentAt.toISOString(),
        channel: step.stepType.toLowerCase(),
        deliveryMode: result.deliveryMode,
      },
    });
    console.log(`[SendProcessor] ${result.log}`);
    return result.deliveryMode === "mock" ? "mock" : "sent";
  }

  await prisma.sequenceStep.update({
    where: { id: step.id },
    data: {
      status: SEQUENCE_STEP_STATUS.FAILED,
      sendLog: result.log,
      deliveryMode: result.deliveryMode,
    },
  });
  await logActivity({
    sequenceId: step.sequenceId,
    stepId: step.id,
    eventType: "step_failed",
    actor: "system",
    meta: { stepOrder: step.stepOrder, stepType: step.stepType, reason: result.log },
  });
  console.error(`[SendProcessor] Step ${step.id} failed: ${result.log}`);
  return "failed";
};

/**
 * One pass of the send processor: every due step (status "scheduled", time
 * at or before now, sequence active), oldest first, at most BATCH_SIZE.
 *
 * Safe to run twice at the same moment (two servers, an overlapping cron, a
 * retry): every change is a conditional update, so a step is sent at most once
 * and a waiting step is moved at most once.
 *
 * An unexpected error on one step is logged with the step id and counted; the
 * other steps still go. The returned summary says what happened.
 */
export const runSendTick = async (
  options: { senders?: Senders; now?: Date } = {}
): Promise<SendTickSummary> => {
  const senders = options.senders ?? defaultSenders;
  const now = options.now ?? new Date();
  const affectedSequenceIds = new Set<string>();
  const summary: SendTickSummary = {
    due: 0,
    sent: 0,
    mock: 0,
    pending: 0,
    failed: 0,
    waiting: 0,
    held: 0,
    skipped: 0,
    interrupted: 0,
    errors: 0,
    errorMessages: [],
  };

  const noteError = (where: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    summary.errors++;
    summary.errorMessages.push(`${where}: ${message}`);
    console.error(`[SendProcessor] Error (${where}):`, error);
  };

  try {
    for (const sequenceId of await failInterruptedSends(now)) {
      affectedSequenceIds.add(sequenceId);
      summary.interrupted++;
    }
  } catch (error) {
    noteError("interrupted sends", error);
  }

  const dueSteps: DueStep[] = await prisma.sequenceStep.findMany({
    where: {
      status: SEQUENCE_STEP_STATUS.SCHEDULED,
      scheduledAt: { lte: now },
      sequence: { status: "active" },
    },
    orderBy: { scheduledAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      sequenceId: true,
      stepOrder: true,
      stepType: true,
      scheduledAt: true,
    },
  });

  summary.due = dueSteps.length;
  if (dueSteps.length > 0) {
    console.log(`[SendProcessor] Processing ${dueSteps.length} due step(s)`);
  }

  for (const step of dueSteps) {
    try {
      const outcome = await handleDueStep(step, now, senders);
      summary[outcome]++;
      if (outcome === "sent" || outcome === "mock" || outcome === "pending" || outcome === "failed") {
        affectedSequenceIds.add(step.sequenceId);
      }
    } catch (error) {
      // A step claimed before the error stays "sending" and is marked failed
      // as interrupted after STALE_SENDING_MINUTES; it is never sent twice.
      noteError(`step ${step.id}`, error);
    }
  }

  for (const seqId of affectedSequenceIds) {
    try {
      await checkSequenceCompletion(seqId);
    } catch (error) {
      noteError(`completion of sequence ${seqId}`, error);
    }
  }

  return summary;
};

let isProcessing = false;

/**
 * Runs one pass unless a pass is already running in this process (then it
 * returns null). Used by the every-minute cron on a normal server and by the
 * send-job endpoint on a serverless host. Passes in different processes may
 * still overlap; runSendTick is safe for that.
 */
export const runSendTickOnce = async (
  options: { senders?: Senders; now?: Date } = {}
): Promise<SendTickSummary | null> => {
  if (isProcessing) return null;
  isProcessing = true;
  try {
    return await runSendTick(options);
  } finally {
    isProcessing = false;
  }
};

/** Cron entry: one pass at a time inside this process. Errors are logged. */
export const processDueSteps = async () => {
  try {
    const summary = await runSendTickOnce();
    if (summary && summary.errors > 0) {
      console.error(`[SendProcessor] Pass finished with ${summary.errors} error(s)`);
    }
  } catch (error) {
    console.error("[SendProcessor] Cron error:", error);
  }
};

export const startSendProcessor = () => {
  cron.schedule("* * * * *", processDueSteps);
  console.log("[SendProcessor] Cron started — checking every minute");
};

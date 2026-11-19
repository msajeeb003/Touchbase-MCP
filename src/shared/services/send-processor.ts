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
let isProcessing = false;

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

    logActivity({
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
 */
const deferStep = async (
  step: { id: string; sequenceId: string; stepOrder: number; scheduledAt: Date },
  newDate: Date,
  note: string
): Promise<void> => {
  const shiftMs = newDate.getTime() - step.scheduledAt.getTime();

  const moved = await prisma.sequenceStep.updateMany({
    where: { id: step.id, status: SEQUENCE_STEP_STATUS.SCHEDULED },
    data: { scheduledAt: newDate, sendLog: note },
  });

  if (moved.count !== 1 || shiftMs <= 0) return;

  await prisma.$executeRaw`
    UPDATE sequence_steps
    SET "scheduledAt" = "scheduledAt" + (${shiftMs}::double precision * interval '1 millisecond')
    WHERE "sequenceId" = ${step.sequenceId}
      AND "stepOrder" > ${step.stepOrder}
      AND "status" = ${SEQUENCE_STEP_STATUS.SCHEDULED}
  `;
};

/**
 * One pass of the send processor.
 *
 * Order of the checks for every due step:
 *  1. the sequence is still active;
 *  2. the lead is not do-not-contact (all four channels);
 *  3. for a sequence made through the harness: inside the user's send window
 *     (email and SMS);
 *  4. CLAIM: the step is moved "scheduled" -> "sending" with a conditional
 *     update. Only the caller whose update changed exactly one row goes on,
 *     so two processors can never send the same step;
 *  5. for a sequence made through the harness: a person approved it and
 *     nothing was changed since (checked on the content that is about to go out);
 *  6. send, then record the result.
 */
export const runSendTick = async (
  options: { senders?: Senders; now?: Date } = {}
): Promise<void> => {
  const senders = options.senders ?? defaultSenders;
  const now = options.now ?? new Date();
  const affectedSequenceIds = new Set<string>();

  for (const sequenceId of await failInterruptedSends(now)) {
    affectedSequenceIds.add(sequenceId);
  }

  // find all the steps that are scheduled and have a scheduled date that is less than or equal to the current date
  // and the sequence is active
  const dueSteps = await prisma.sequenceStep.findMany({
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

  if (dueSteps.length > 0) {
    console.log(`[SendProcessor] Processing ${dueSteps.length} due step(s)`);
  }

  for (const step of dueSteps) {
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

    // if the sequence is not active, skip the step
    if (sequence?.status !== "active") {
      continue;
    }

    // 2. do-not-contact: nothing goes out on any channel
    if (await isLeadBlocked(sequence.lead)) {
      await prisma.sequenceStep.updateMany({
        where: { id: step.id, status: SEQUENCE_STEP_STATUS.SCHEDULED },
        data: { sendLog: DO_NOT_CONTACT_LOG },
      });
      await pauseSequenceBySystem(sequence.id, "do_not_contact");
      console.log(`[SendProcessor] Step ${step.id}: ${DO_NOT_CONTACT_LOG}`);
      continue;
    }

    const isHarnessSequence = sequence.runId !== null;

    // 3. send window (harness sequences, email and SMS)
    if (
      isHarnessSequence &&
      (step.stepType === "EMAIL" || step.stepType === "SMS")
    ) {
      const sendWindow = await loadSendWindow(sequence.userId);

      if (!sendWindow.ok) {
        await deferStep(
          step,
          new Date(now.getTime() + NO_TIMEZONE_RECHECK_MINUTES * 60_000),
          `Waiting: ${sendWindow.message}`
        );
        continue;
      }

      if (!isInsideSendWindow(now, sendWindow.window)) {
        const opensAt = nextAllowedTime(now, sendWindow.window);
        await deferStep(
          step,
          opensAt,
          `Waiting for the send window. Moved to ${opensAt.toISOString()}.`
        );
        continue;
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

    if (claimed.count !== 1) {
      // another processor took it, or it was paused or edited in the meantime
      continue;
    }

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
      continue;
    }

    // 6. send
    const result = await processStep(
      {
        id: step.id,
        stepType: content.stepType,
        subject: content.subject,
        content: content.content,
        sequence: {
          id: sequence.id,
          userId: sequence.userId,
          lead: sequence.lead,
        },
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
          ...(result.externalMessageId && {
            externalMessageId: result.externalMessageId,
          }),
        },
      });
      logActivity({
        sequenceId: step.sequenceId,
        stepId:     step.id,
        eventType:  "step_sending",
        actor:      "system",
        meta:       { stepOrder: step.stepOrder, stepType: step.stepType, externalMessageId: result.externalMessageId ?? null },
      });
      console.log(`[SendProcessor] ${result.log}`);
    } else if (result.success) {
      await prisma.sequenceStep.update({
        where: { id: step.id },
        data: {
          status: SEQUENCE_STEP_STATUS.SENT,
          sentAt: new Date(),
          sendLog: result.log,
          deliveryMode: result.deliveryMode,
        },
      });
      logActivity({
        sequenceId: step.sequenceId,
        stepId:     step.id,
        eventType:  "step_sent",
        actor:      "system",
        meta:       { stepOrder: step.stepOrder, stepType: step.stepType, sentAt: new Date().toISOString(), channel: step.stepType.toLowerCase(), deliveryMode: result.deliveryMode },
      });
      console.log(`[SendProcessor] ${result.log}`);
    } else {
      await prisma.sequenceStep.update({
        where: { id: step.id },
        data: {
          status: SEQUENCE_STEP_STATUS.FAILED,
          sendLog: result.log,
          deliveryMode: result.deliveryMode,
        },
      });
      logActivity({
        sequenceId: step.sequenceId,
        stepId:     step.id,
        eventType:  "step_failed",
        actor:      "system",
        meta:       { stepOrder: step.stepOrder, stepType: step.stepType, reason: result.log },
      });
      console.log(`[SendProcessor] Step ${step.id}: ${result.log}`);
    }

    affectedSequenceIds.add(step.sequenceId);
  }

  for (const seqId of affectedSequenceIds) {
    await checkSequenceCompletion(seqId);
  }
};

/** Cron entry: one pass at a time inside this process. */
export const processDueSteps = async () => {
  console.log("Time", new Date().toISOString());
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    await runSendTick();
  } catch (error) {
    console.error("[SendProcessor] Cron error:", error);
  } finally {
    isProcessing = false;
  }
};

export const startSendProcessor = () => {
  cron.schedule("* * * * *", processDueSteps);
  console.log("[SendProcessor] Cron started — checking every minute");
};

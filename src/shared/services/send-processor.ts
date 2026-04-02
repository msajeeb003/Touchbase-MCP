import cron from "node-cron";
import prisma from "../prisma";
import { syncLeadStatusFromActiveSequences } from "../../modules/lead/lead.service";
import { sendEmail } from "./email.service";
import { sendSms } from "./sms.service";
import config from "../../config";

const BATCH_SIZE = config.batch_size;
let isProcessing = false;

const processStep = async (step: {
  id: string;
  stepType: string;
  subject: string | null;
  content: string | null;
  sequence: {
    id: string;
    userId: string;
    status: string;
    lead: {
      name: string;
      email: string | null;
      phone: string | null;
    };
  };
}): Promise<{ success: boolean; log: string }> => {
  if (step.sequence.status !== "active") {
    return { success: false, log: "Failed: Sequence no longer active" };
  }

  if (!step.content) {
    return { success: false, log: "Failed: Step has no content" };
  }

  try {
    if (step.stepType === "EMAIL") {
      if (!step.sequence.lead.email) {
        return { success: false, log: "Failed: Lead has no email address" };
      }

      await sendEmail(step.sequence.userId, {
        to: step.sequence.lead.email,
        subject: step.subject || "(No Subject)",
        text: step.content,
      });

      return {
        success: true,
        log: `Email sent to ${step.sequence.lead.email}`,
      };
    } else if (step.stepType === "SMS") {
      if (!step.sequence.lead.phone) {
        return { success: false, log: "Failed: Lead has no phone number" };
      }

      await sendSms(
        step.sequence.userId,
        step.sequence.lead.phone,
        step.content
      );

      return {
        success: true,
        log: `SMS sent to ${step.sequence.lead.phone}`,
      };
    }

    return { success: false, log: "Failed: Unknown step type" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";
    return { success: false, log: `Failed: ${message}` };
  }
};

const checkSequenceCompletion = async (sequenceId: string) => {
  const remaining = await prisma.sequenceStep.count({
    where: {
      sequenceId,
      status: "scheduled",
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

    console.log(`[SendProcessor] Sequence ${sequenceId} completed`);
  }
};

const processDueSteps = async () => {
  console.log("Time", new Date().toISOString());
  if (isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    // find all the steps that are scheduled and have a scheduled date that is less than or equal to the current date
    // and the sequence is active
    // and the sequence is not completed
    // and the sequence is not cancelled
    // and the sequence is not paused
    const dueSteps = await prisma.sequenceStep.findMany({
      where: {
        status: "scheduled",
        scheduledAt: { lte: new Date() },
        sequence: { status: "active" },
      },
      orderBy: { scheduledAt: "asc" },
      take: BATCH_SIZE,
      include: {
        sequence: {
          include: {
            lead: {
              select: { name: true, email: true, phone: true },
            },
          },
        },
      },
    });

    if (dueSteps.length === 0) {
      return;
    }

    console.log(
      `[SendProcessor] Processing ${dueSteps.length} due step(s)`
    );


    // process the steps
    const affectedSequenceIds = new Set<string>();

    // loop through the steps and process them
    for (const step of dueSteps) {
      // check if the sequence is active
      const freshSequence = await prisma.sequence.findUnique({
        where: { id: step.sequenceId },
        select: { status: true },
      });

      // if the sequence is not active, skip the step
      if (freshSequence?.status !== "active") {
        console.log(
          `[SendProcessor] Step ${step.id} skipped — sequence no longer active`
        );
        continue;
      }

      // process the step
      const result = await processStep(step);

      if (result.success) {
        await prisma.sequenceStep.update({
          where: { id: step.id },
          data: {
            status: "sent",
            sentAt: new Date(),
            sendLog: result.log,
          },
        });
        console.log(`[SendProcessor] ${result.log}`);
      } else {
        await prisma.sequenceStep.update({
          where: { id: step.id },
          data: {
            status: "failed",
            sendLog: result.log,
          },
        });
        console.log(`[SendProcessor] Step ${step.id}: ${result.log}`);
      }

      affectedSequenceIds.add(step.sequenceId);
    }

    for (const seqId of affectedSequenceIds) {
      await checkSequenceCompletion(seqId);
    }
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

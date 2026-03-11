import cron from "node-cron";
import prisma from "../prisma";
import { sendEmail } from "./email.service";
import { sendSms } from "./sms.service";
import config from "@/config";

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
      email: string;
      phone: string;
    };
  };
}): Promise<{ success: boolean; error?: string }> => {
  if (step.sequence.status !== "active") {
    return { success: false, error: "Sequence no longer active" };
  }

  if (!step.content) {
    return { success: false, error: "Step has no content" };
  }

  try {
    if (step.stepType === "EMAIL") {
      if (!step.sequence.lead.email) {
        return { success: false, error: "Lead has no email address" };
      }

      await sendEmail(step.sequence.userId, {
        to: step.sequence.lead.email,
        subject: step.subject || "(No Subject)",
        text: step.content,
      });
    } else if (step.stepType === "SMS") {
      if (!step.sequence.lead.phone) {
        return { success: false, error: "Lead has no phone number" };
      }

      await sendSms(
        step.sequence.userId,
        step.sequence.lead.phone,
        step.content
      );
    }

    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";
    return { success: false, error: message };
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
    await prisma.sequence.update({
      where: { id: sequenceId },
      data: { status: "completed" },
    });
    console.log(`[SendProcessor] Sequence ${sequenceId} completed`);
  }
};

const processDueSteps = async () => {
  console.log("processDueSteps- ", new Date());
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
    console.log({BATCH_SIZE});
    console.log({dueSteps});

    if (dueSteps.length === 0) {
      return;
    }

    console.log(
      `[SendProcessor] Processing ${dueSteps.length} due step(s)`
    );


    // process the steps
    const affectedSequenceIds = new Set<string>();
    console.log({affectedSequenceIds});

    // loop through the steps and process them
    for (const step of dueSteps) {
      // check if the sequence is active
      const freshSequence = await prisma.sequence.findUnique({
        where: { id: step.sequenceId },
        select: { status: true },
      });

      console.log({freshSequence});

      // if the sequence is not active, skip the step
      if (freshSequence?.status !== "active") {
        console.log(
          `[SendProcessor] Step ${step.id} skipped — sequence no longer active`
        );
        continue;
      }

      // process the step
      const result = await processStep(step);

      console.log({result});

      // if the step is processed successfully, update the step status to sent
      if (result.success) {
        await prisma.sequenceStep.update({
          where: { id: step.id },
          data: { status: "sent", sentAt: new Date() },
        });
        console.log(
          `[SendProcessor] Step ${step.id} (${step.stepType}) sent to ${step.sequence.lead.email || step.sequence.lead.phone}`
        );
      } else {
        // if the step is not processed successfully, update the step status to failed
        await prisma.sequenceStep.update({
          where: { id: step.id },
          data: { status: "failed" },
        });
        console.log(
          `[SendProcessor] Step ${step.id} failed: ${result.error}`
        );
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

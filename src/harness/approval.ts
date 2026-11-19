import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";

/**
 * AI harness, rule 1: Claude prepares, a human releases.
 *
 * When a logged-in person activates a sequence, the app stores who did it,
 * when, and a hash of exactly what they released: every step's channel,
 * subject and text, and the address it goes to.
 *
 * For a sequence made through the harness (it has a runId), the send
 * processor sends a step only if that record exists and the hash still
 * matches. So a message or a recipient changed after approval is not sent
 * until a person approves again.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type ApprovalHashInput = {
  leadEmail: string | null;
  leadPhone: string | null;
  steps: {
    stepOrder: number;
    stepType: string;
    subject: string | null;
    content: string | null;
  }[];
};

export const computeApprovalHash = (input: ApprovalHashInput): string => {
  const canonical = JSON.stringify({
    v: 1,
    to: {
      email: (input.leadEmail ?? "").trim().toLowerCase(),
      phone: (input.leadPhone ?? "").replace(/\s+/g, ""),
    },
    steps: [...input.steps]
      .sort((a, b) => a.stepOrder - b.stepOrder)
      .map((step) => [
        step.stepOrder,
        step.stepType,
        step.subject ?? "",
        step.content ?? "",
      ]),
  });

  return createHash("sha256").update(canonical).digest("hex");
};

/** The hash of the sequence as it is in the database right now. */
export const currentApprovalHash = async (
  sequenceId: string,
  db: Db = prisma
): Promise<string | null> => {
  const sequence = await db.sequence.findUnique({
    where: { id: sequenceId },
    select: {
      lead: { select: { email: true, phone: true } },
      steps: {
        select: { stepOrder: true, stepType: true, subject: true, content: true },
      },
    },
  });

  if (!sequence) return null;

  return computeApprovalHash({
    leadEmail: sequence.lead.email,
    leadPhone: sequence.lead.phone,
    steps: sequence.steps,
  });
};

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; reason: "not_approved" | "changed_after_approval" };

/**
 * May a step of this sequence be sent?
 * Sequences made in the app's own wizard (no runId) keep today's behaviour.
 */
export const checkApprovedForSend = async (sequence: {
  id: string;
  runId: string | null;
  approvalStatus: string;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  approvedContentHash: string | null;
}): Promise<ApprovalCheck> => {
  if (!sequence.runId) return { ok: true };

  if (
    sequence.approvalStatus !== "approved" ||
    !sequence.approvedAt ||
    !sequence.approvedByUserId ||
    !sequence.approvedContentHash
  ) {
    return { ok: false, reason: "not_approved" };
  }

  const current = await currentApprovalHash(sequence.id);
  if (current !== sequence.approvedContentHash) {
    return { ok: false, reason: "changed_after_approval" };
  }

  return { ok: true };
};

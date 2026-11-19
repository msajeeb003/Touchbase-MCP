import type { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";
import { SEQUENCE_STATUS } from "../shared/constants";

/**
 * Why a sequence is paused. Stored in sequences."pausedReason".
 * Pausing only ever stops sending, so the system and Claude may do it.
 * Starting again is a person's decision in the app.
 */
export type PauseReason =
  | "lead_replied"
  | "do_not_contact"
  | "not_approved"
  | "changed_after_approval"
  | "paused_by_claude"
  | "paused_by_user";

type Db = Prisma.TransactionClient | typeof prisma;

/** Same rule as lead.service: a lead is "Active" only while it has an active sequence. */
export const syncLeadStatus = async (leadId: string, db: Db = prisma): Promise<void> => {
  const activeCount = await db.sequence.count({
    where: { leadId, status: SEQUENCE_STATUS.ACTIVE },
  });
  await db.lead.update({
    where: { id: leadId },
    data: { status: activeCount > 0 ? "Active" : "Not Active" },
  });
};

/**
 * Pauses one sequence if (and only if) it is active right now.
 * Returns true when this call paused it.
 *
 * Pass the caller's transaction as `db` to make the pause part of it.
 */
export const pauseSequenceBySystem = async (
  sequenceId: string,
  reason: PauseReason,
  db: Db = prisma,
  actor: "system" | "claude" = "system",
  note?: string | null
): Promise<boolean> => {
  const result = await db.sequence.updateMany({
    where: { id: sequenceId, status: SEQUENCE_STATUS.ACTIVE },
    data: {
      status: SEQUENCE_STATUS.PAUSED,
      pausedReason: reason,
      pausedAt: new Date(),
    },
  });

  if (result.count !== 1) return false;

  const activity = db.sequenceActivity.create({
    data: {
      sequenceId,
      eventType: "sequence_status_changed",
      actor,
      meta: {
        from: SEQUENCE_STATUS.ACTIVE,
        to: SEQUENCE_STATUS.PAUSED,
        reason,
        ...(note ? { note } : {}),
      },
    },
  });
  // Inside a caller's transaction the log line is part of it. On its own it
  // is best effort, like the rest of the activity log.
  if (db === prisma) await activity.catch(() => {});
  else await activity;

  const sequence = await db.sequence.findUnique({
    where: { id: sequenceId },
    select: { leadId: true },
  });
  if (sequence) await syncLeadStatus(sequence.leadId, db);

  return true;
};

/**
 * Pauses every active sequence of one lead.
 *
 * `onlyIfStartedBefore`: used for replies. An email that arrived before the
 * sequence was approved is not a reply to it, so it does not pause it.
 */
export const pauseActiveSequencesForLead = async (
  leadId: string,
  reason: PauseReason,
  options: { onlyIfStartedBefore?: Date } = {},
  db: Db = prisma
): Promise<string[]> => {
  const active = await db.sequence.findMany({
    where: { leadId, status: SEQUENCE_STATUS.ACTIVE },
    select: { id: true, approvedAt: true, createdAt: true },
  });

  const paused: string[] = [];

  for (const sequence of active) {
    if (options.onlyIfStartedBefore) {
      const startedAt = sequence.approvedAt ?? sequence.createdAt;
      if (startedAt > options.onlyIfStartedBefore) continue;
    }

    if (await pauseSequenceBySystem(sequence.id, reason, db)) {
      paused.push(sequence.id);
    }
  }

  return paused;
};

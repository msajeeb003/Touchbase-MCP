import type { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";
import AppError from "../shared/errors/AppError";
import type { Actor } from "./actor";
import { type Db, findLead, STEP_STATUS } from "./common";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { syncLeadStatus } from "./pause";
import { requirePermission } from "./permissions";

/**
 * AI harness: soft delete of a lead by Claude (delete_lead), only while
 * "Claude can delete leads" is on.
 *
 *  - The lead is hidden everywhere (lists, search, tools, dashboard) but kept.
 *  - A person can restore it in the app for RESTORE_DAYS days; after that a
 *    daily job removes it for good.
 *  - First its running sequences are stopped and its drafts cancelled.
 *  - A do-not-contact block on its email or phone stays (suppressed_contacts
 *    has no link to the lead row).
 */

export const RESTORE_DAYS = 30;
const DAY_MS = 86_400_000;

const UNSENT = [
  STEP_STATUS.PENDING,
  STEP_STATUS.DRAFT,
  STEP_STATUS.SCHEDULED,
  STEP_STATUS.SENDING,
  STEP_STATUS.CALLING,
];

/** Stops every open sequence of the lead. Returns the ids that were stopped. */
const stopOpenSequences = async (db: Db, leadId: string, reason: string): Promise<string[]> => {
  const open = await db.sequence.findMany({
    where: { leadId, status: { in: ["draft", "active", "paused"] } },
    select: { id: true, status: true },
  });
  for (const sequence of open) {
    await db.sequenceStep.updateMany({
      where: { sequenceId: sequence.id, status: { in: UNSENT } },
      data: { status: STEP_STATUS.SKIPPED },
    });
    await db.sequence.update({
      where: { id: sequence.id },
      data: { status: "cancelled", approvalStatus: "none", approvalRequestedAt: null },
    });
    await db.sequenceActivity.create({
      data: {
        sequenceId: sequence.id,
        eventType: "sequence_status_changed",
        actor: "claude",
        meta: { from: sequence.status, to: "cancelled", reason: "lead_deleted", note: reason },
      },
    });
  }
  return open.map((s) => s.id);
};

export const deleteLeadByClaude = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string; reason: string }
): Promise<HarnessOutcome> => {
  await requirePermission(db, actor.userId, "delete_leads");

  const reason = input.reason.trim().slice(0, LIMITS.REASON_MAX);
  if (!reason) {
    throw new HarnessError("VALIDATION", "A reason is required.", "Say in a few words why the lead is deleted.");
  }

  // Already deleted: a repeat changes nothing.
  const deleted = await db.lead.findFirst({
    where: { id: input.lead_id, userId: actor.userId, deletedAt: { not: null } },
  });
  if (deleted) {
    return {
      result: {
        lead_id: deleted.id,
        deleted: true,
        already_deleted: true,
        restorable_until: new Date(deleted.deletedAt!.getTime() + RESTORE_DAYS * DAY_MS).toISOString(),
      },
      summary: "The lead was already deleted: nothing was changed",
      touched: [{ type: "lead", id: deleted.id }],
    };
  }

  const lead = await findLead(db, actor.userId, input.lead_id);
  const stopped = await stopOpenSequences(db, lead.id, reason);
  const now = new Date();
  await db.lead.update({
    where: { id: lead.id },
    data: { deletedAt: now, deletedReason: reason, deletedBy: "claude" },
  });
  await syncLeadStatus(lead.id, db);

  return {
    result: {
      lead_id: lead.id,
      deleted: true,
      already_deleted: false,
      sequences_stopped: stopped,
      do_not_contact_kept: lead.doNotContact,
      restorable_until: new Date(now.getTime() + RESTORE_DAYS * DAY_MS).toISOString(),
      note: `The lead is hidden. A person can restore it in the Touchbase app (Leads → Recently deleted) for ${RESTORE_DAYS} days. Stopped sequences are not restarted by a restore.`,
    },
    summary: `Deleted lead ${lead.name}`,
    touched: [{ type: "lead", id: lead.id, label: lead.name }],
    detail: { reason },
  };
};

// ── for the app (login token only) ───────────────────────────────────

export const listDeletedLeads = async (userId: string) => {
  const since = new Date(Date.now() - RESTORE_DAYS * DAY_MS);
  const leads = await prisma.lead.findMany({
    where: { userId, deletedAt: { not: null, gte: since } },
    orderBy: { deletedAt: "desc" },
    take: 200,
  });
  return leads.map((lead) => ({
    ...lead,
    restorableUntil: new Date(lead.deletedAt!.getTime() + RESTORE_DAYS * DAY_MS).toISOString(),
  }));
};

export const restoreLead = async (userId: string, leadId: string) => {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, userId, deletedAt: { not: null } },
  });
  if (!lead) throw new AppError(404, "Deleted lead not found");
  if (lead.deletedAt!.getTime() < Date.now() - RESTORE_DAYS * DAY_MS) {
    throw new AppError(410, `This lead was deleted more than ${RESTORE_DAYS} days ago and cannot be restored.`);
  }
  return prisma.lead.update({
    where: { id: lead.id },
    data: { deletedAt: null, deletedReason: null, deletedBy: null },
  });
};

/** Removes leads deleted more than RESTORE_DAYS ago, for good. Do-not-contact rows stay. */
export const purgeDeletedLeads = async (db: Db | typeof prisma = prisma): Promise<number> => {
  const result = await (db as Prisma.TransactionClient).lead.deleteMany({
    where: { deletedAt: { lt: new Date(Date.now() - RESTORE_DAYS * DAY_MS) } },
  });
  return result.count;
};

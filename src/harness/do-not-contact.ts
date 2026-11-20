import type { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";
import AppError from "../shared/errors/AppError";
import { pauseActiveSequencesForLead } from "./pause";

/**
 * AI harness, rule 4: do-not-contact.
 *
 * Two things work together:
 *  - a row per blocked address in "suppressed_contacts" (what every check uses), and
 *  - a flag on the lead (so lists and screens can show it quickly).
 *
 * A row is kept when its lead is deleted, so the same address stays blocked
 * if it is imported again.
 *
 * Setting the block is allowed for anyone acting for the user (a person, the
 * MCP server, the system). Clearing it is for a logged-in person only: see
 * clearLeadDoNotContact, which is reached only through the REST endpoint.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Who set the block. "lead_opt_out" means the lead asked (SMS STOP, an
 * unsubscribe, or a reply asking not to be contacted). No tool can ever clear
 * a lead_opt_out block.
 */
export type DoNotContactSource = "mcp" | "user" | "system" | "lead_opt_out";

export const LEAD_OPT_OUT = "lead_opt_out";

const activityActorFor = (source: DoNotContactSource): string =>
  source === "mcp" ? "claude" : source === LEAD_OPT_OUT ? "lead" : source;

export const DO_NOT_CONTACT_REASON_MAX = 300;

export const DO_NOT_CONTACT_MESSAGE =
  "This lead is marked do-not-contact, so no message can be sent to them. " +
  "A logged-in person can clear the mark on the lead if it is a mistake.";

/** Lower-cased, trimmed email, or null when there is none. */
export const normalizeEmailAddress = (
  email: string | null | undefined
): string | null => {
  const value = (email ?? "").trim().toLowerCase();
  return value.includes("@") ? value : null;
};

/**
 * Phone as "+digits", or null when there is none.
 * Spaces, brackets and dashes are dropped; a leading "00" is read as "+".
 * A number written once with and once without its country code is NOT matched.
 */
export const normalizePhoneNumber = (
  phone: string | null | undefined
): string | null => {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^00/, "");
  return digits.length >= 5 ? `+${digits}` : null;
};

const addressFilters = (
  email: string | null | undefined,
  phone: string | null | undefined
): { kind: string; value: string }[] => {
  const filters: { kind: string; value: string }[] = [];
  const normalizedEmail = normalizeEmailAddress(email);
  const normalizedPhone = normalizePhoneNumber(phone);
  if (normalizedEmail) filters.push({ kind: "email", value: normalizedEmail });
  if (normalizedPhone) filters.push({ kind: "phone", value: normalizedPhone });
  return filters;
};

/**
 * The one check used everywhere: is this email or this phone blocked for this user?
 */
export const isBlocked = async (
  userId: string,
  email: string | null | undefined,
  phone: string | null | undefined,
  db: Db = prisma
): Promise<{ blocked: boolean; by: string[] }> => {
  const filters = addressFilters(email, phone);
  if (filters.length === 0) return { blocked: false, by: [] };

  const rows = await db.suppressedContact.findMany({
    where: { userId, clearedAt: null, OR: filters },
    select: { kind: true },
  });

  return { blocked: rows.length > 0, by: rows.map((row) => row.kind) };
};

/** A lead is blocked when its flag is set, or when one of its addresses is blocked. */
export const isLeadBlocked = async (
  lead: {
    userId: string;
    doNotContact: boolean;
    email: string | null;
    phone: string | null;
  },
  db: Db = prisma
): Promise<boolean> => {
  if (lead.doNotContact) return true;
  return (await isBlocked(lead.userId, lead.email, lead.phone, db)).blocked;
};

const FLAG_FOR_BLOCKED_ADDRESS = "This address is on your do-not-contact list";

type BlockedLeadFields = {
  doNotContact?: boolean;
  doNotContactAt?: Date;
  doNotContactReason?: string;
  doNotContactSource?: string;
};

/** The lead fields that mark a lead whose address is already blocked. */
export const blockedLeadFields = (): BlockedLeadFields => ({
  doNotContact: true,
  doNotContactAt: new Date(),
  doNotContactReason: FLAG_FOR_BLOCKED_ADDRESS,
  doNotContactSource: "system",
});

/**
 * Extra fields for a lead that is being created or whose address is changing.
 * Empty for a normal lead. A lead whose email or phone is already blocked
 * gets the flag at once.
 */
export const doNotContactFieldsForNewLead = async (
  userId: string,
  email: string | null | undefined,
  phone: string | null | undefined,
  db: Db = prisma
): Promise<BlockedLeadFields> => {
  const { blocked } = await isBlocked(userId, email, phone, db);
  return blocked ? blockedLeadFields() : {};
};

/** All blocked addresses of one user, for checking many rows at once (import). */
export const loadBlockedAddresses = async (
  userId: string,
  db: Db = prisma
): Promise<{ has: (email?: string | null, phone?: string | null) => boolean }> => {
  const rows = await db.suppressedContact.findMany({
    where: { userId, clearedAt: null },
    select: { kind: true, value: true },
  });
  const blocked = new Set(rows.map((row) => `${row.kind}:${row.value}`));

  return {
    has: (email, phone) =>
      addressFilters(email, phone).some((f) => blocked.has(`${f.kind}:${f.value}`)),
  };
};

/**
 * Marks a lead do-not-contact. Safe to call twice: the second call changes nothing.
 * Every active sequence of the lead is paused.
 */
export const markLeadDoNotContact = async (
  params: {
    userId: string;
    leadId: string;
    reason?: string | null;
    source: DoNotContactSource;
    runId?: string | null;
  },
  /** The caller's transaction, when the mark must be part of it (MCP tools). */
  outer?: Prisma.TransactionClient
) => {
  const lead = await (outer ?? prisma).lead.findFirst({
    where: { id: params.leadId, userId: params.userId },
    select: { id: true, email: true, phone: true, doNotContact: true, doNotContactSource: true },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  const reason = params.reason?.trim().slice(0, DO_NOT_CONTACT_REASON_MAX) || null;
  const now = new Date();
  let changed = false;
  const addressesBlocked = addressFilters(lead.email, lead.phone).map((a) => a.kind);

  const work = async (tx: Prisma.TransactionClient) => {
    for (const address of addressFilters(lead.email, lead.phone)) {
      const key = {
        userId_kind_value: {
          userId: params.userId,
          kind: address.kind,
          value: address.value,
        },
      };
      const existing = await tx.suppressedContact.findUnique({ where: key });

      if (!existing) {
        await tx.suppressedContact.create({
          data: {
            userId: params.userId,
            kind: address.kind,
            value: address.value,
            reason,
            source: params.source,
            runId: params.runId ?? null,
            leadId: lead.id,
          },
        });
        changed = true;
      } else if (
        !existing.clearedAt &&
        params.source === LEAD_OPT_OUT &&
        existing.source !== LEAD_OPT_OUT
      ) {
        // Already blocked, and now the lead asked too: it becomes the lead's own opt-out.
        await tx.suppressedContact.update({
          where: key,
          data: { source: LEAD_OPT_OUT, reason: reason ?? existing.reason, runId: params.runId ?? null },
        });
        changed = true;
      } else if (existing.clearedAt) {
        // Blocked again after a person had cleared it.
        await tx.suppressedContact.update({
          where: key,
          data: {
            reason,
            source: params.source,
            runId: params.runId ?? null,
            leadId: lead.id,
            createdAt: now,
            clearedAt: null,
            clearedByUserId: null,
            clearReason: null,
          },
        });
        changed = true;
      }
    }

    if (!lead.doNotContact || (params.source === LEAD_OPT_OUT && lead.doNotContactSource !== LEAD_OPT_OUT)) {
      changed = true;
      return tx.lead.update({
        where: { id: lead.id },
        data: {
          doNotContact: true,
          doNotContactAt: now,
          doNotContactReason: reason,
          doNotContactSource: params.source,
        },
      });
    }

    return tx.lead.findUniqueOrThrow({ where: { id: lead.id } });
  };

  const updated = outer ? await work(outer) : await prisma.$transaction(work);

  const db = outer ?? prisma;
  const pausedSequenceIds = await pauseActiveSequencesForLead(
    lead.id,
    "do_not_contact",
    {},
    db
  );
  const cancelledDraftIds = await cancelOpenDrafts(db, lead.id, params.source);

  return {
    lead: updated,
    alreadyMarked: !changed,
    pausedSequenceIds,
    cancelledDraftIds,
    addressesBlocked,
  };
};

/**
 * Drafts of a do-not-contact lead can never be approved or sent, so they are
 * cancelled instead of being left in the approval queue. Their unsent steps
 * are marked skipped. Running sequences are paused, not cancelled (above),
 * so a person can see what had already gone out.
 */
const cancelOpenDrafts = async (
  db: Prisma.TransactionClient | typeof prisma,
  leadId: string,
  source: DoNotContactSource
): Promise<string[]> => {
  const drafts = await db.sequence.findMany({
    where: { leadId, status: "draft" },
    select: { id: true },
  });

  for (const draft of drafts) {
    await db.sequenceStep.updateMany({
      where: { sequenceId: draft.id, status: { in: ["pending", "draft"] } },
      data: { status: "skipped" },
    });
    await db.sequence.update({
      where: { id: draft.id },
      data: { status: "cancelled", approvalStatus: "none", approvalRequestedAt: null },
    });
    const log = db.sequenceActivity.create({
      data: {
        sequenceId: draft.id,
        eventType: "sequence_status_changed",
        actor: activityActorFor(source),
        meta: { from: "draft", to: "cancelled", reason: "do_not_contact" },
      },
    });
    if (db === prisma) await log.catch(() => {});
    else await log;
  }

  return drafts.map((d) => d.id);
};

/**
 * Clears do-not-contact for a lead. FOR A LOGGED-IN PERSON ONLY.
 *
 * Do not call this from the MCP server or from any automated path. It is
 * reached only through POST /leads/:id/do-not-contact/clear, which accepts a
 * login session and nothing else.
 *
 * The rows are kept and stamped with who cleared them, when and why.
 * Paused sequences stay paused: a person resumes them.
 */
export const clearLeadDoNotContact = async (params: {
  userId: string;
  leadId: string;
  reason: string;
}) => {
  const reason = params.reason.trim().slice(0, DO_NOT_CONTACT_REASON_MAX);
  if (!reason) {
    throw new AppError(400, "A reason is required to clear do-not-contact");
  }

  const lead = await prisma.lead.findFirst({
    where: { id: params.leadId, userId: params.userId },
    select: {
      id: true,
      userId: true,
      email: true,
      phone: true,
      doNotContact: true,
      doNotContactSource: true,
    },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  // The lead's own opt-out (an SMS STOP, an unsubscribe) is never cleared in
  // Touchbase, not even by a person: only the lead can choose to be contacted again.
  if (await isLeadOptOut(lead)) {
    throw new AppError(
      409,
      "This lead opted out themselves (for example by replying STOP). That can't be cleared in Touchbase."
    );
  }

  const filters = addressFilters(lead.email, lead.phone);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const cleared =
      filters.length > 0
        ? await tx.suppressedContact.updateMany({
            where: { userId: params.userId, clearedAt: null, OR: filters },
            data: {
              clearedAt: now,
              clearedByUserId: params.userId,
              clearReason: reason,
            },
          })
        : { count: 0 };

    if (!lead.doNotContact && cleared.count === 0) {
      throw new AppError(400, "This lead is not marked do-not-contact");
    }

    const updated = await tx.lead.update({
      where: { id: lead.id },
      data: {
        doNotContact: false,
        doNotContactAt: null,
        doNotContactReason: null,
        doNotContactSource: null,
      },
    });

    return { lead: updated, clearedAddresses: cleared.count };
  });
};

/** Is any active block on this lead the lead's own opt-out? */
export const isLeadOptOut = async (
  lead: { userId: string; email: string | null; phone: string | null; doNotContactSource: string | null },
  db: Db = prisma
): Promise<boolean> => {
  if (lead.doNotContactSource === LEAD_OPT_OUT) return true;
  const filters = addressFilters(lead.email, lead.phone);
  if (filters.length === 0) return false;
  const rows = await db.suppressedContact.count({
    where: { userId: lead.userId, clearedAt: null, source: LEAD_OPT_OUT, OR: filters },
  });
  return rows > 0;
};

/**
 * Clears do-not-contact for Claude (clear_do_not_contact tool), only while the
 * workspace switch is on (checked by the caller). Never clears the lead's own
 * opt-out: the caller refuses that first, and this checks again.
 * Safe to call twice. Does not restart any sequence.
 */
export const clearDoNotContactForClaude = async (
  db: Prisma.TransactionClient,
  params: { userId: string; leadId: string; reason: string }
) => {
  const lead = await db.lead.findFirst({
    where: { id: params.leadId, userId: params.userId, deletedAt: null },
  });
  if (!lead) throw new AppError(404, "Lead not found");
  if (await isLeadOptOut(lead, db)) {
    throw new AppError(403, "The lead opted out themselves.");
  }

  const filters = addressFilters(lead.email, lead.phone);
  const cleared =
    filters.length > 0
      ? await db.suppressedContact.updateMany({
          where: { userId: params.userId, clearedAt: null, OR: filters },
          data: { clearedAt: new Date(), clearedByUserId: params.userId, clearReason: params.reason },
        })
      : { count: 0 };

  if (!lead.doNotContact && cleared.count === 0) {
    return { lead, alreadyClear: true, clearedAddresses: 0 };
  }

  const updated = await db.lead.update({
    where: { id: lead.id },
    data: { doNotContact: false, doNotContactAt: null, doNotContactReason: null, doNotContactSource: null },
  });
  return { lead: updated, alreadyClear: false, clearedAddresses: cleared.count };
};

/**
 * Blocks one phone number as the person's own opt-out (an SMS STOP), also when
 * no lead has that number yet. Safe to call twice.
 */
export const blockPhoneAsOptOut = async (
  db: Db,
  userId: string,
  phone: string,
  reason: string
): Promise<boolean> => {
  const value = normalizePhoneNumber(phone);
  if (!value) return false;
  const key = { userId_kind_value: { userId, kind: "phone", value } };
  const existing = await db.suppressedContact.findUnique({ where: key });
  if (existing && !existing.clearedAt && existing.source === LEAD_OPT_OUT) return false;
  if (!existing) {
    await db.suppressedContact.create({
      data: { userId, kind: "phone", value, reason, source: LEAD_OPT_OUT },
    });
  } else {
    await db.suppressedContact.update({
      where: key,
      data: {
        reason,
        source: LEAD_OPT_OUT,
        createdAt: new Date(),
        clearedAt: null,
        clearedByUserId: null,
        clearReason: null,
      },
    });
  }
  return true;
};

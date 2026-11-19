import type { Lead, Prisma } from "@prisma/client";
import type { Actor } from "./actor";
import { type Db, findLead, leadView, pageOf, pagination } from "./common";
import {
  doNotContactFieldsForNewLead,
  loadBlockedAddresses,
  blockedLeadFields,
  markLeadDoNotContact,
  normalizeEmailAddress,
  normalizePhoneNumber,
} from "./do-not-contact";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { replyTrackingEnabled } from "./switches";

/**
 * AI harness: leads.
 *
 * Reading never changes anything. Writing can add a lead, correct its details
 * and mark it do-not-contact. Nothing here can delete a lead or remove a
 * do-not-contact mark.
 */

const OPEN_SEQUENCE = ["draft", "active", "paused"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

// ── reading ──────────────────────────────────────────────────────────

/** Last message sent, last reply, transcript count and open sequence, for a page of leads. */
const activityFor = async (db: Db, userId: string, leadIds: string[]) => {
  const info = new Map(
    leadIds.map((id) => [
      id,
      {
        last_sent_at: null as string | null,
        last_reply_at: null as string | null,
        transcript_count: 0,
        open_sequence_id: null as string | null,
      },
    ])
  );
  if (leadIds.length === 0) return info;

  const [replies, transcripts, sequences] = await Promise.all([
    db.leadInboundEmail.groupBy({
      by: ["leadId"],
      where: { userId, leadId: { in: leadIds } },
      _max: { receivedAt: true },
    }),
    db.leadTranscript.groupBy({
      by: ["leadId"],
      where: { userId, leadId: { in: leadIds } },
      _count: { _all: true },
    }),
    db.sequence.findMany({
      where: { userId, leadId: { in: leadIds } },
      orderBy: { createdAt: "desc" },
      select: { id: true, leadId: true, status: true },
    }),
  ]);

  for (const row of replies) {
    const entry = info.get(row.leadId);
    if (entry) entry.last_reply_at = row._max.receivedAt?.toISOString() ?? null;
  }
  for (const row of transcripts) {
    const entry = info.get(row.leadId);
    if (entry) entry.transcript_count = row._count._all;
  }

  const leadOfSequence = new Map(sequences.map((s) => [s.id, s.leadId]));
  for (const sequence of sequences) {
    const entry = info.get(sequence.leadId);
    if (entry && !entry.open_sequence_id && OPEN_SEQUENCE.includes(sequence.status)) {
      entry.open_sequence_id = sequence.id;
    }
  }

  if (sequences.length > 0) {
    const sent = await db.sequenceStep.groupBy({
      by: ["sequenceId"],
      where: { sequenceId: { in: sequences.map((s) => s.id) }, status: "sent" },
      _max: { sentAt: true },
    });
    for (const row of sent) {
      const entry = info.get(leadOfSequence.get(row.sequenceId) ?? "");
      const at = row._max.sentAt?.toISOString() ?? null;
      if (entry && at && (!entry.last_sent_at || at > entry.last_sent_at)) {
        entry.last_sent_at = at;
      }
    }
  }

  return info;
};

export const searchLeads = async (
  actor: Actor,
  db: Db,
  input: {
    query?: string;
    follow_up_stage?: string;
    lead_status?: string;
    has_email?: boolean;
    has_phone?: boolean;
    do_not_contact?: boolean;
    no_reply_in_days?: number;
    not_contacted_in_days?: number;
    has_open_sequence?: boolean;
    has_transcript?: boolean;
    created_after?: string;
    page?: number;
    page_size?: number;
  }
): Promise<HarnessOutcome> => {
  const { page, size, skip } = pageOf(input);
  const and: Prisma.LeadWhereInput[] = [{ userId: actor.userId }];

  if (input.query?.trim()) {
    const text = input.query.trim();
    and.push({
      OR: [
        { name: { contains: text, mode: "insensitive" } },
        { email: { contains: text, mode: "insensitive" } },
        { company: { contains: text, mode: "insensitive" } },
      ],
    });
  }
  if (input.follow_up_stage) {
    and.push({ followUpStage: { equals: input.follow_up_stage, mode: "insensitive" } });
  }
  if (input.lead_status) and.push({ status: input.lead_status });
  if (input.has_email !== undefined) {
    and.push(input.has_email ? { email: { not: null } } : { email: null });
  }
  if (input.has_phone !== undefined) {
    and.push(input.has_phone ? { phone: { not: null } } : { phone: null });
  }
  if (input.do_not_contact !== undefined) and.push({ doNotContact: input.do_not_contact });
  if (input.has_transcript !== undefined) {
    and.push({ transcripts: input.has_transcript ? { some: {} } : { none: {} } });
  }
  if (input.has_open_sequence !== undefined) {
    const open = { status: { in: OPEN_SEQUENCE } };
    and.push({ sequences: input.has_open_sequence ? { some: open } : { none: open } });
  }
  if (input.created_after) and.push({ createdAt: { gt: new Date(input.created_after) } });
  if (input.no_reply_in_days !== undefined) {
    and.push({
      inboundEmails: { none: { receivedAt: { gte: daysAgo(input.no_reply_in_days) } } },
    });
  }
  if (input.not_contacted_in_days !== undefined) {
    and.push({
      sequences: {
        none: {
          steps: {
            some: { status: "sent", sentAt: { gte: daysAgo(input.not_contacted_in_days) } },
          },
        },
      },
    });
  }

  const where: Prisma.LeadWhereInput = { AND: and };
  const [leads, total] = await Promise.all([
    db.lead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: size,
    }),
    db.lead.count({ where }),
  ]);
  const activity = await activityFor(db, actor.userId, leads.map((l) => l.id));

  const notes: string[] = [];
  if (input.no_reply_in_days !== undefined) {
    notes.push(
      "no_reply_in_days looks at email replies only, and includes leads who never replied. SMS replies are not recorded by Touchbase."
    );
    if (!replyTrackingEnabled()) {
      notes.push(
        "Reply tracking is switched off on this server, so no new replies are being recorded. Leads may have replied without it showing here. Tell the user."
      );
    }
  }

  return {
    result: {
      leads: leads.map((lead) => ({ ...leadView(lead), ...activity.get(lead.id) })),
      ...pagination(page, size, total),
      notes,
    },
    summary: `Searched leads: ${total} found`,
  };
};

export const getLead = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string }
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);
  const [activity, replies, sequences] = await Promise.all([
    activityFor(db, actor.userId, [lead.id]),
    db.leadInboundEmail.count({ where: { userId: actor.userId, leadId: lead.id } }),
    db.sequence.groupBy({
      by: ["status"],
      where: { userId: actor.userId, leadId: lead.id },
      _count: { _all: true },
    }),
  ]);

  return {
    result: {
      lead: {
        ...leadView(lead, true),
        ...activity.get(lead.id),
        reply_count: replies,
        sequences_by_status: Object.fromEntries(
          sequences.map((row) => [row.status, row._count._all])
        ),
        do_not_contact_since: lead.doNotContactAt?.toISOString() ?? null,
      },
    },
    summary: "Read one lead",
    touched: [{ type: "lead", id: lead.id }],
  };
};

// ── writing ──────────────────────────────────────────────────────────

type LeadFields = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  location?: string | null;
  follow_up_stage?: string | null;
  notes?: string | null;
};

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? "").trim();
  return text ? text : null;
};

const invalid = (message: string, nextStep = "Correct the value and call the tool again.") =>
  new HarnessError("VALIDATION", message, nextStep);

/** Checks one lead's fields. Returns the problem as text, or null when they are fine. */
const problemWith = (fields: {
  name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
}): string | null => {
  if (!fields.name) return "A name is required.";
  if (fields.name.length > LIMITS.SEQUENCE_NAME_MAX) return "The name is too long (150 characters at most).";
  if (!fields.email && !fields.phone) return "An email address or a phone number is required.";
  if (fields.email && !EMAIL.test(fields.email)) return "The email address is not valid.";
  if (fields.phone && !normalizePhoneNumber(fields.phone)) return "The phone number is not valid.";
  if (fields.notes && fields.notes.length > LIMITS.NOTES_MAX) {
    return `The notes are too long (${LIMITS.NOTES_MAX} characters at most).`;
  }
  return null;
};

/** An existing lead of this user with the same email (any capitals) or the same phone. */
const findSameLead = async (
  db: Db,
  userId: string,
  email: string | null,
  phone: string | null,
  exceptLeadId?: string
): Promise<Lead | null> => {
  const not = exceptLeadId ? { id: { not: exceptLeadId } } : {};

  if (email) {
    const byEmail = await db.lead.findFirst({
      where: { userId, email: { equals: email, mode: "insensitive" }, ...not },
    });
    if (byEmail) return byEmail;
  }

  const wanted = normalizePhoneNumber(phone);
  if (wanted) {
    const withPhone = await db.lead.findMany({
      where: { userId, phone: { not: null }, ...not },
      select: { id: true, phone: true },
    });
    const match = withPhone.find((l) => normalizePhoneNumber(l.phone) === wanted);
    if (match) return db.lead.findUnique({ where: { id: match.id } });
  }

  return null;
};

export const createLead = async (
  actor: Actor,
  db: Db,
  input: LeadFields & { name: string }
): Promise<HarnessOutcome> => {
  const fields = {
    name: clean(input.name),
    email: clean(input.email),
    phone: clean(input.phone),
    notes: clean(input.notes),
  };
  const problem = problemWith(fields);
  if (problem) throw invalid(problem);

  const existing = await findSameLead(db, actor.userId, fields.email, fields.phone);
  if (existing) {
    return {
      result: {
        lead: leadView(existing),
        already_existed: true,
        do_not_contact: existing.doNotContact,
      },
      summary: "A lead with this email or phone already existed: nothing was added",
      touched: [{ type: "lead", id: existing.id, label: existing.name }],
    };
  }

  const lead = await db.lead.create({
    data: {
      userId: actor.userId,
      name: fields.name as string,
      email: fields.email,
      phone: fields.phone,
      notes: fields.notes,
      company: clean(input.company),
      location: clean(input.location),
      followUpStage: clean(input.follow_up_stage) ?? "New",
      ...(await doNotContactFieldsForNewLead(actor.userId, fields.email, fields.phone, db)),
    },
  });

  return {
    result: {
      lead: leadView(lead),
      already_existed: false,
      do_not_contact: lead.doNotContact,
      ...(lead.doNotContact
        ? {
            note: "This address is on the user's do-not-contact list. The lead was added, but no message can be sent to them.",
          }
        : {}),
    },
    summary: `Added the lead ${lead.name}`,
    touched: [{ type: "lead", id: lead.id, label: lead.name }],
  };
};

export const updateLead = async (
  actor: Actor,
  db: Db,
  input: LeadFields & { lead_id: string }
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);

  const next = {
    name: input.name !== undefined ? clean(input.name) : lead.name,
    email: input.email !== undefined ? clean(input.email) : lead.email,
    phone: input.phone !== undefined ? clean(input.phone) : lead.phone,
    notes: input.notes !== undefined ? clean(input.notes) : lead.notes,
    company: input.company !== undefined ? clean(input.company) : lead.company,
    location: input.location !== undefined ? clean(input.location) : lead.location,
    followUpStage:
      input.follow_up_stage !== undefined ? clean(input.follow_up_stage) : lead.followUpStage,
  };

  const problem = problemWith(next);
  if (problem) throw invalid(problem);

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== lead[key]
  );

  if (changed.length === 0) {
    return {
      result: { lead: leadView(lead, true), changed_fields: [] },
      summary: "The lead already had these values: nothing was changed",
      touched: [{ type: "lead", id: lead.id, label: lead.name }],
    };
  }

  const addressChanged = changed.includes("email") || changed.includes("phone");
  if (addressChanged) {
    const other = await findSameLead(db, actor.userId, next.email, next.phone, lead.id);
    if (other) {
      throw new HarnessError(
        "CONFLICT",
        "Another lead of this user already has this email address or phone number.",
        "Use that lead instead, or tell the user that the two leads may be the same person."
      );
    }
  }

  const updated = await db.lead.update({
    where: { id: lead.id },
    data: {
      name: next.name as string,
      email: next.email,
      phone: next.phone,
      notes: next.notes,
      company: next.company,
      location: next.location,
      followUpStage: next.followUpStage,
      // A lead can gain the do-not-contact mark here. It can never lose it here.
      ...(addressChanged && !lead.doNotContact
        ? await doNotContactFieldsForNewLead(actor.userId, next.email, next.phone, db)
        : {}),
    },
  });

  const labels: Record<string, string> = { followUpStage: "follow_up_stage" };
  const warnings: string[] = [];
  if (addressChanged) {
    warnings.push(
      "The email or phone changed. Any sequence a person already approved for this lead will be paused before its next message, until a person approves it again."
    );
  }

  return {
    result: {
      lead: leadView(updated, true),
      changed_fields: changed.map((key) => labels[key] ?? key),
      warnings,
    },
    summary: `Updated the lead ${updated.name}: ${changed.map((key) => labels[key] ?? key).join(", ")}`,
    touched: [{ type: "lead", id: updated.id, label: updated.name }],
  };
};

export const importLeads = async (
  actor: Actor,
  db: Db,
  input: { rows: (LeadFields & { name?: string })[] }
): Promise<HarnessOutcome> => {
  if (input.rows.length > LIMITS.ROWS_PER_IMPORT) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `At most ${LIMITS.ROWS_PER_IMPORT} rows can be imported in one call.`,
      `Send the rows in groups of ${LIMITS.ROWS_PER_IMPORT}.`
    );
  }

  const blocked = await loadBlockedAddresses(actor.userId, db);
  const existing = await db.lead.findMany({
    where: { userId: actor.userId },
    select: { email: true, phone: true },
  });
  const seenEmails = new Set(
    existing.map((l) => normalizeEmailAddress(l.email)).filter((v): v is string => Boolean(v))
  );
  const seenPhones = new Set(
    existing.map((l) => normalizePhoneNumber(l.phone)).filter((v): v is string => Boolean(v))
  );

  const invalidRows: { row: number; reason: string }[] = [];
  const leadIds: string[] = [];
  let duplicates = 0;
  let blockedCount = 0;

  for (let index = 0; index < input.rows.length; index++) {
    const row = input.rows[index];
    const fields = {
      name: clean(row.name),
      email: clean(row.email),
      phone: clean(row.phone),
      notes: clean(row.notes),
    };
    const problem = problemWith(fields);
    if (problem) {
      invalidRows.push({ row: index + 1, reason: problem });
      continue;
    }

    const email = normalizeEmailAddress(fields.email);
    const phone = normalizePhoneNumber(fields.phone);
    if ((email && seenEmails.has(email)) || (phone && seenPhones.has(phone))) {
      duplicates++;
      continue;
    }
    if (email) seenEmails.add(email);
    if (phone) seenPhones.add(phone);

    const isBlocked = blocked.has(fields.email, fields.phone);
    if (isBlocked) blockedCount++;

    const lead = await db.lead.create({
      data: {
        userId: actor.userId,
        name: fields.name as string,
        email: fields.email,
        phone: fields.phone,
        notes: fields.notes,
        company: clean(row.company),
        location: clean(row.location),
        followUpStage: clean(row.follow_up_stage) ?? "New",
        ...(isBlocked ? blockedLeadFields() : {}),
      },
      select: { id: true },
    });
    leadIds.push(lead.id);
  }

  return {
    result: {
      added: leadIds.length,
      duplicates_skipped: duplicates,
      blocked_as_do_not_contact: blockedCount,
      invalid: invalidRows,
      lead_ids: leadIds,
    },
    summary: `Imported leads: ${leadIds.length} added, ${duplicates} already there, ${invalidRows.length} not valid`,
    touched: leadIds.slice(0, 20).map((id) => ({ type: "lead", id })),
  };
};

export const markDoNotContact = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string; reason: string },
  runId: string | null
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);

  const marked = await markLeadDoNotContact(
    {
      userId: actor.userId,
      leadId: lead.id,
      reason: input.reason,
      source: "mcp",
      runId,
    },
    db
  );

  return {
    result: {
      lead_id: lead.id,
      do_not_contact: true,
      already_marked: marked.alreadyMarked,
      addresses_blocked: marked.addressesBlocked,
      sequences_paused: marked.pausedSequenceIds,
      drafts_cancelled: marked.cancelledDraftIds,
      note: "No message can be sent to this lead any more. Running sequences were paused and open drafts cancelled. Only a logged-in person can undo the mark, in the Touchbase app.",
    },
    summary: marked.alreadyMarked
      ? `${lead.name} was already marked do-not-contact`
      : `Marked ${lead.name} do-not-contact`,
    touched: [{ type: "lead", id: lead.id, label: lead.name }],
  };
};

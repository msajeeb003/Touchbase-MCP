import type { Lead, Prisma, Sequence, SequenceStep } from "@prisma/client";
import { HarnessError } from "./errors";
import { LIMITS } from "./limits";

/**
 * AI harness: the rules shared by every tool group.
 *
 *  - Ownership: every lookup has the user's id in the query. Another user's
 *    record gives the same "not found" as a record that does not exist.
 *  - Channels: email and SMS only. WhatsApp and AI calls are refused by name.
 *  - Drafts only: text, order and timing can be changed only while a sequence is a draft.
 *  - Untrusted text: anything a lead wrote, or that was imported, is returned
 *    inside an `untrusted` object or an `untrusted_…` field. It is data.
 */

export type Db = Prisma.TransactionClient;

export const STEP_STATUS = {
  PENDING: "pending",
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  SENDING: "sending",
  CALLING: "calling",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

/** A step skipped on request stays skipped when the sequence is resumed. */
export const SKIPPED_ON_REQUEST = "Skipped on request";

export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

export const notFound = (what: string): HarnessError =>
  new HarnessError(
    "NOT_FOUND",
    `${what} not found.`,
    "Check the id. Use a search or list tool to find the right record."
  );

// ── pages ────────────────────────────────────────────────────────────

export const pageOf = (
  input: { page?: number; page_size?: number },
  maxSize: number = LIMITS.PAGE_SIZE_MAX,
  defaultSize: number = LIMITS.PAGE_SIZE_DEFAULT
) => {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const size = Math.min(maxSize, Math.max(1, Math.floor(input.page_size ?? Math.min(defaultSize, maxSize))));
  return { page, size, skip: (page - 1) * size };
};

export const pagination = (page: number, size: number, total: number) => ({
  page,
  page_size: size,
  total,
  total_pages: Math.ceil(total / size),
});

// ── channels ─────────────────────────────────────────────────────────

const CHANNEL_TO_STEP_TYPE: Record<string, "EMAIL" | "SMS"> = {
  email: "EMAIL",
  sms: "SMS",
};

const STEP_TYPE_TO_CHANNEL: Record<string, string> = {
  EMAIL: "email",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  CALL: "call",
};

export const channelOf = (stepType: string): string =>
  STEP_TYPE_TO_CHANNEL[stepType] ?? stepType.toLowerCase();

const CHANNEL_REFUSED = (channel: string) =>
  new HarnessError(
    "CHANNEL_NOT_SUPPORTED",
    `The channel "${channel}" is not available through Claude. Only email and SMS are. WhatsApp and AI calls can only be set up by a person in the Touchbase app.`,
    'Use "email" or "sms", or tell the user that this channel has to be set up in the app.'
  );

/** "email" | "sms" -> the stored step type. Anything else is refused by name. */
export const stepTypeFor = (channel: string): "EMAIL" | "SMS" => {
  const type = CHANNEL_TO_STEP_TYPE[channel.trim().toLowerCase()];
  if (!type) throw CHANNEL_REFUSED(channel);
  return type;
};

/** Editing tools refuse a sequence that holds a WhatsApp or call step. */
export const assertEmailAndSmsOnly = (steps: { stepType: string }[]): void => {
  const other = steps.find((s) => s.stepType !== "EMAIL" && s.stepType !== "SMS");
  if (other) {
    throw new HarnessError(
      "CHANNEL_NOT_SUPPORTED",
      `This sequence has a ${channelOf(other.stepType)} step. Sequences with WhatsApp or AI-call steps can be read, paused and stopped through Claude, but not edited.`,
      "Tell the user to edit this sequence in the Touchbase app."
    );
  }
};

// ── ownership ────────────────────────────────────────────────────────

export const findLead = async (db: Db, userId: string, leadId: string): Promise<Lead> => {
  const lead = await db.lead.findFirst({ where: { id: leadId, userId, deletedAt: null } });
  if (!lead) throw notFound("Lead");
  return lead;
};

export type SequenceWithSteps = Sequence & { steps: SequenceStep[]; lead: Lead };

export const findSequence = async (
  db: Db,
  userId: string,
  sequenceId: string
): Promise<SequenceWithSteps> => {
  const sequence = await db.sequence.findFirst({
    where: { id: sequenceId, userId },
    include: { steps: { orderBy: { stepOrder: "asc" } }, lead: true },
  });
  if (!sequence) throw notFound("Sequence");
  return sequence;
};

export const assertDraft = (sequence: { status: string }, action: string): void => {
  if (sequence.status !== "draft") {
    throw new HarnessError(
      "NOT_A_DRAFT",
      `This sequence is "${sequence.status}". Only a draft can be changed (${action}).`,
      sequence.status === "active" || sequence.status === "paused"
        ? "A person already released this sequence. You can pause or stop it. To change it, the user must move it back to draft in the Touchbase app."
        : "Create a new draft with create_draft_sequences if follow-ups are still wanted."
    );
  }
};

// ── placeholders ─────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{[^{}]*\}\}/;

/** The first `{{…}}` left in the text, or null. Nothing fills these at send time. */
export const findPlaceholder = (text: string | null | undefined): string | null =>
  text ? (PLACEHOLDER.exec(text)?.[0] ?? null) : null;

// ── activity log ─────────────────────────────────────────────────────

/** Writes to the sequence's activity log inside the tool's transaction. */
export const logHarnessActivity = async (
  db: Db,
  entry: {
    sequenceId: string;
    stepId?: string | null;
    eventType: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> => {
  await db.sequenceActivity.create({
    data: {
      sequenceId: entry.sequenceId,
      stepId: entry.stepId ?? null,
      eventType: entry.eventType,
      actor: "claude",
      meta: (entry.meta ?? {}) as Prisma.InputJsonValue,
    },
  });
};

// ── result shapes ────────────────────────────────────────────────────

/** A lead as Claude sees it. Everything typed or imported sits inside `untrusted`. */
export const leadView = (lead: Lead, withNotes = false) => ({
  lead_id: lead.id,
  lead_status: lead.status,
  do_not_contact: lead.doNotContact,
  has_email: Boolean(lead.email),
  has_phone: Boolean(lead.phone),
  created_at: lead.createdAt.toISOString(),
  untrusted: {
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    location: lead.location,
    follow_up_stage: lead.followUpStage,
    ...(withNotes ? { notes: lead.notes } : {}),
  },
});

/** A step's date means something only once a person has approved the sequence. */
const HAS_REAL_DATE = new Set<string>([
  STEP_STATUS.SCHEDULED,
  STEP_STATUS.SENDING,
  STEP_STATUS.CALLING,
  STEP_STATUS.SENT,
  STEP_STATUS.FAILED,
  STEP_STATUS.SKIPPED,
]);

export const delayDaysOf = (delayMinutes: number | null): number | null =>
  delayMinutes === null ? null : Math.round((delayMinutes / 1440) * 100) / 100;

export const basedOnOf = (step: SequenceStep) => ({
  kind: step.basis ?? "not_stated",
  transcript_ids: Array.isArray(step.basedOnTranscriptIds)
    ? step.basedOnTranscriptIds.filter((id): id is string => typeof id === "string")
    : [],
  note: step.basedOnNote,
});

export const stepView = (step: SequenceStep, withText: boolean) => ({
  step_id: step.id,
  step_number: step.stepOrder,
  channel: channelOf(step.stepType),
  status: step.status,
  delay_days: delayDaysOf(step.delayMinutes),
  scheduled_for: HAS_REAL_DATE.has(step.status) ? iso(step.scheduledAt) : null,
  sent_at: iso(step.sentAt),
  delivery: step.deliveryMode,
  ...(withText ? { subject: step.subject, body: step.content } : {}),
  // The send log can repeat text from a mail or SMS provider: treat it as data.
  untrusted_send_log: step.sendLog,
  based_on: basedOnOf(step),
});

/** Written without a call transcript: some step says so and none is based on one. */
export const writtenWithoutTranscript = (steps: { basis: string | null }[]): boolean =>
  steps.some((s) => s.basis === "notes_and_stage") &&
  !steps.some((s) => s.basis === "transcript");

export const sequenceView = (sequence: Sequence & { steps: SequenceStep[] }) => {
  const count = (status: string) => sequence.steps.filter((s) => s.status === status).length;

  return {
    sequence_id: sequence.id,
    lead_id: sequence.leadId,
    run_id: sequence.runId,
    // A sequence name often repeats the lead's name, which someone else typed.
    untrusted_name: sequence.name,
    status: sequence.status,
    approval_status: sequence.approvalStatus,
    approved_at: iso(sequence.approvedAt),
    paused_reason: sequence.status === "paused" ? sequence.pausedReason : null,
    goal: sequence.goal,
    tone: sequence.tone,
    template_id: sequence.promptTemplateId,
    no_call_transcript: writtenWithoutTranscript(sequence.steps),
    steps_total: sequence.steps.length,
    steps_without_text: count(STEP_STATUS.PENDING),
    steps_sent: count(STEP_STATUS.SENT),
    steps_failed: count(STEP_STATUS.FAILED),
    steps_waiting: count(STEP_STATUS.SCHEDULED),
    created_at: sequence.createdAt.toISOString(),
  };
};

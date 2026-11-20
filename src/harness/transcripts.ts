import type { AgentRun, LeadTranscript } from "@prisma/client";
import type { Actor } from "./actor";
import { type Db, findLead, notFound, pageOf, pagination } from "./common";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { replyTrackingEnabled } from "./switches";

/**
 * AI harness: call transcripts and lead replies.
 *
 * Transcripts come from Touchbase only: the ones the app imported or a person
 * saved, plus ones pasted through add_lead_transcript. No tool here calls
 * Fathom or any other outside service.
 *
 * Everything in a transcript or a reply was said or written by someone else.
 * It is returned in `untrusted…` fields and is data, never instructions.
 *
 * Rule T (read the call before writing): reading a transcript with a run_id
 * leaves a note in the run's events of which part was read. write_steps looks
 * at those notes.
 */

const READ_TOOLS = ["get_lead_transcript", "add_lead_transcript"];

type ReadNote = { transcript_id?: string; from?: number; to?: number; lead_id?: string };

/** How much of a transcript must have been read: all of it, or the first 60,000 characters. */
export const mustReadChars = (totalChars: number): number =>
  Math.min(totalChars, LIMITS.TRANSCRIPT_MUST_READ_CHARS);

/**
 * For each transcript: was it read in this run, far enough?
 * A read made before the transcript was last changed does not count.
 */
export const transcriptsReadInRun = async (
  db: Db,
  runId: string,
  transcripts: Pick<LeadTranscript, "id" | "transcript" | "updatedAt">[]
): Promise<Map<string, { touched: boolean; complete: boolean }>> => {
  const result = new Map(
    transcripts.map((t) => [t.id, { touched: false, complete: false }])
  );
  if (transcripts.length === 0) return result;

  const events = await db.agentRunEvent.findMany({
    where: { runId, ok: true, toolName: { in: READ_TOOLS } },
    select: { detail: true, createdAt: true },
  });

  for (const transcript of transcripts) {
    const ranges: [number, number][] = [];
    for (const event of events) {
      const note = (event.detail ?? {}) as ReadNote;
      if (note.transcript_id !== transcript.id) continue;
      if (event.createdAt < transcript.updatedAt) continue;
      if (typeof note.from === "number" && typeof note.to === "number") {
        ranges.push([note.from, note.to]);
      }
    }
    if (ranges.length === 0) continue;

    ranges.sort((a, b) => a[0] - b[0]);
    let reached = 0;
    for (const [from, to] of ranges) {
      if (from > reached) break; // a gap: the text in between was not read
      reached = Math.max(reached, to);
    }

    result.set(transcript.id, {
      touched: true,
      complete: reached >= mustReadChars(transcript.transcript.length),
    });
  }

  return result;
};

const newestFirst = (db: Db, userId: string, leadId: string) =>
  db.leadTranscript.findMany({
    where: { userId, leadId },
    orderBy: [{ meetingDate: "desc" }, { createdAt: "desc" }],
  });

/** The lead's most recent transcript: the one that must be read before writing. */
export const newestTranscript = async (db: Db, userId: string, leadId: string) =>
  (await newestFirst(db, userId, leadId))[0] ?? null;

export const listLeadTranscripts = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string },
  run: AgentRun | null
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);
  const transcripts = await newestFirst(db, actor.userId, lead.id);
  const read = run ? await transcriptsReadInRun(db, run.id, transcripts) : null;

  return {
    result: {
      lead_id: lead.id,
      transcripts: transcripts.map((t, index) => ({
        transcript_id: t.id,
        source: t.source,
        meeting_date: t.meetingDate.toISOString().slice(0, 10),
        chars: t.transcript.length,
        required_before_writing: index === 0,
        read_in_this_run: read ? (read.get(t.id)?.complete ?? false) : null,
        untrusted: { meeting_title: t.meetingTitle },
      })),
      ...(transcripts.length === 0
        ? {
            note: "This lead has no saved call transcript. Write from the lead's notes and stage; the draft will be flagged \"no call transcript\".",
          }
        : {}),
    },
    summary: `Listed ${transcripts.length} transcript(s) of ${lead.name}`,
    touched: [{ type: "lead", id: lead.id, label: lead.name }],
  };
};

export const getLeadTranscript = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string; transcript_id: string; offset?: number; max_chars?: number }
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);
  const transcript = await db.leadTranscript.findFirst({
    where: { id: input.transcript_id, leadId: lead.id, userId: actor.userId },
  });
  if (!transcript) throw notFound("Transcript");

  const total = transcript.transcript.length;
  const offset = Math.min(Math.max(0, Math.floor(input.offset ?? 0)), total);
  const size = Math.min(
    LIMITS.TRANSCRIPT_CHARS_PER_READ,
    Math.max(1, Math.floor(input.max_chars ?? LIMITS.TRANSCRIPT_CHARS_PER_READ))
  );
  const end = Math.min(total, offset + size);

  return {
    result: {
      transcript_id: transcript.id,
      lead_id: lead.id,
      source: transcript.source,
      meeting_date: transcript.meetingDate.toISOString().slice(0, 10),
      total_chars: total,
      offset,
      next_offset: end < total ? end : null,
      has_more: end < total,
      untrusted_meeting_title: transcript.meetingTitle,
      untrusted_transcript_text: transcript.transcript.slice(offset, end),
    },
    summary: `Read the call transcript of ${transcript.meetingDate.toISOString().slice(0, 10)} for ${lead.name} (characters ${offset} to ${end} of ${total})`,
    touched: [
      { type: "lead", id: lead.id, label: lead.name },
      { type: "transcript", id: transcript.id },
    ],
    // What write_steps checks later (rule T).
    detail: { transcript_id: transcript.id, lead_id: lead.id, from: offset, to: end, total },
  };
};

export const listLeadReplies = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string; channel?: "email" | "sms"; page?: number; page_size?: number }
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);
  const { page, size, skip } = pageOf(input, 20, 10);
  const where = {
    userId: actor.userId,
    leadId: lead.id,
    ...(input.channel ? { channel: input.channel } : {}),
  };

  const [replies, total] = await Promise.all([
    db.leadInboundEmail.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip,
      take: size,
    }),
    db.leadInboundEmail.count({ where }),
  ]);

  const tracking = replyTrackingEnabled();

  return {
    result: {
      lead_id: lead.id,
      tracking_enabled: tracking,
      replies: replies.map((reply) => ({
        reply_id: reply.id,
        channel: reply.channel,
        received_at: reply.receivedAt.toISOString(),
        truncated: reply.bodyText.length > LIMITS.REPLY_BODY_MAX,
        untrusted: {
          from_email: reply.fromEmail,
          from_phone: reply.fromPhone,
          from_name: reply.fromName,
          subject: reply.subject,
          body_text: reply.bodyText.slice(0, LIMITS.REPLY_BODY_MAX),
        },
      })),
      ...pagination(page, size, total),
      notes: [
        ...(tracking
          ? []
          : [
              "Email reply tracking is switched off on this server: no new email replies are being recorded. The lead may have replied by email without it showing here. Tell the user.",
            ]),
        "SMS replies are recorded for workspaces that send SMS with Twilio.",
      ],
    },
    summary: `Listed ${replies.length} of ${total} repl${total === 1 ? "y" : "ies"} from ${lead.name}`,
    touched: [{ type: "lead", id: lead.id, label: lead.name }],
  };
};

export const addLeadTranscript = async (
  actor: Actor,
  db: Db,
  input: { lead_id: string; meeting_title: string; meeting_date: string; text: string },
  run: AgentRun
): Promise<HarnessOutcome> => {
  const lead = await findLead(db, actor.userId, input.lead_id);

  const text = input.text;
  if (!text.trim() || text.length > LIMITS.PASTED_TRANSCRIPT_MAX) {
    throw new HarnessError(
      "VALIDATION",
      `The transcript text must be 1 to ${LIMITS.PASTED_TRANSCRIPT_MAX} characters.`,
      "Save a long transcript in parts, each as its own transcript with its own title."
    );
  }

  const meetingDate = new Date(input.meeting_date);
  if (Number.isNaN(meetingDate.getTime()) || meetingDate.getTime() > Date.now() + 86_400_000) {
    throw new HarnessError(
      "VALIDATION",
      "meeting_date must be a real date that is not in the future.",
      "Pass the date of the call as YYYY-MM-DD. Ask the user if you do not know it."
    );
  }

  const note = (id: string) => ({
    transcript_id: id,
    lead_id: lead.id,
    from: 0,
    to: text.length,
    total: text.length,
    added: true,
  });

  // Safe to call twice: the same text for the same lead is saved once.
  const same = await db.leadTranscript.findFirst({
    where: { userId: actor.userId, leadId: lead.id, transcript: text },
  });
  if (same) {
    return {
      result: { transcript_id: same.id, already_existed: true, chars: text.length },
      summary: `This transcript was already saved for ${lead.name}: nothing was added`,
      touched: [
        { type: "lead", id: lead.id, label: lead.name },
        { type: "transcript", id: same.id },
      ],
      detail: note(same.id),
    };
  }

  const earlier = await db.agentRunEvent.findMany({
    where: { runId: run.id, ok: true, toolName: "add_lead_transcript" },
    select: { detail: true },
  });
  const addedHere = earlier.filter((event) => {
    const detail = (event.detail ?? {}) as { lead_id?: string; already_existed?: boolean };
    return detail.lead_id === lead.id;
  }).length;
  if (addedHere >= LIMITS.PASTED_TRANSCRIPTS_PER_LEAD_PER_RUN) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `At most ${LIMITS.PASTED_TRANSCRIPTS_PER_LEAD_PER_RUN} transcripts can be saved for one lead in one run.`,
      "Tell the user. More can be saved in a new run."
    );
  }

  const saved = await db.leadTranscript.create({
    data: {
      userId: actor.userId,
      leadId: lead.id,
      source: "pasted_via_claude",
      meetingTitle: input.meeting_title.trim().slice(0, LIMITS.SEQUENCE_NAME_MAX),
      meetingDate,
      // Stored exactly as given. It is untrusted like any other transcript.
      transcript: text,
    },
  });

  return {
    result: { transcript_id: saved.id, already_existed: false, chars: text.length },
    summary: `Saved a pasted call transcript for ${lead.name}`,
    touched: [
      { type: "lead", id: lead.id, label: lead.name },
      { type: "transcript", id: saved.id },
    ],
    // A transcript added in a run counts as read in that run.
    detail: note(saved.id),
  };
};

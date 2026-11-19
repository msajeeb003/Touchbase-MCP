import type { AgentRun, AgentRunEvent, Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import type { Actor } from "../actor";
import { HarnessError } from "../errors";
import { LIMITS, limitsForClaude } from "../limits";
import { loadSendWindow } from "../send-window";
import { outboundMode } from "../switches";

/**
 * AI harness: run tracking.
 *
 * One RUN is one instruction the user typed in Claude. Every tool call made
 * for it is one EVENT in that run, numbered 1, 2, 3 ... The Touchbase app
 * reads runs and events to show what Claude did and where each step stands.
 *
 * Every function here takes the user's id and puts it in the query: a run
 * that belongs to someone else looks exactly like a run that does not exist.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type Touched = { type: string; id: string; label?: string };

export const RUN_STATUS = {
  IN_PROGRESS: "in_progress",
  AWAITING_APPROVAL: "awaiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
} as const;

const RUN_NOT_FOUND = () =>
  new HarnessError(
    "RUN_NOT_FOUND",
    "There is no run with this run_id.",
    "Call start_run with the user's instruction and use the run_id it returns."
  );

const RUN_CLOSED = (status: string) =>
  new HarnessError(
    "RUN_CLOSED",
    `This run is closed (${status}). Nothing more can be done inside it.`,
    "Call start_run to begin a new run for the user's new instruction."
  );

// ── what Claude is told when a run starts ────────────────────────────

export const describeRunContext = async (userId: string, db: Db = prisma) => {
  const settings = await db.userSettings.findUnique({
    where: { userId },
    select: {
      sendWindowStart: true,
      sendWindowEnd: true,
      sendOnWeekends: true,
      sendTimezone: true,
    },
  });
  const sendWindow = await loadSendWindow(userId, db);
  const mode = outboundMode();
  const warnings: string[] = [];

  if (!sendWindow.ok) {
    warnings.push(
      sendWindow.code === "NO_TIMEZONE"
        ? "No timezone is set. You can prepare drafts, but a person must set a timezone in Touchbase Settings before any sequence from this run can be approved. Tell the user."
        : `${sendWindow.message} Tell the user.`
    );
  }

  if (mode === "mock") {
    warnings.push(
      "This Touchbase server is in mock mode: after a person approves, messages are recorded as mock sends and nothing is really sent."
    );
  }

  return {
    outbound_mode: mode,
    send_window: {
      start: settings?.sendWindowStart ?? "09:00",
      end: settings?.sendWindowEnd ?? "18:00",
      send_on_weekends: settings?.sendOnWeekends ?? false,
      timezone: settings?.sendTimezone ?? null,
      ready: sendWindow.ok,
    },
    limits: limitsForClaude(),
    warnings,
  };
};

// ── starting, loading and closing a run ──────────────────────────────

/**
 * Starts a run. Safe to call twice: the same user sending the same
 * instruction again within ten minutes, before anything else was done in the
 * run, gets the same run back instead of a second one.
 */
export const startRun = async (
  actor: Actor,
  input: { instruction: string },
  db: Db = prisma
): Promise<{ run: AgentRun; reused: boolean }> => {
  const instruction = input.instruction.trim();

  if (!instruction || instruction.length > LIMITS.INSTRUCTION_MAX) {
    throw new HarnessError(
      "VALIDATION",
      `The instruction must be 1 to ${LIMITS.INSTRUCTION_MAX} characters.`,
      "Pass the user's instruction in their own words, shortened if needed."
    );
  }

  const repeat = await db.agentRun.findFirst({
    where: {
      userId: actor.userId,
      instruction,
      status: RUN_STATUS.IN_PROGRESS,
      finishedAt: null,
      createdAt: {
        gt: new Date(Date.now() - LIMITS.START_RUN_REPEAT_MINUTES * 60_000),
      },
      // nothing but the start itself has happened in it
      events: { none: { toolName: { not: "start_run" } } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (repeat) {
    return { run: repeat, reused: true };
  }

  const recent = await db.agentRun.count({
    where: {
      userId: actor.userId,
      createdAt: { gt: new Date(Date.now() - 3_600_000) },
    },
  });

  if (recent >= LIMITS.RUNS_PER_USER_PER_HOUR) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `At most ${LIMITS.RUNS_PER_USER_PER_HOUR} runs can be started per hour.`,
      "Keep working in the run you already have, or tell the user to try again later."
    );
  }

  const run = await db.agentRun.create({
    data: {
      userId: actor.userId,
      instruction,
      clientName: actor.clientName?.slice(0, 100) ?? null,
    },
  });

  return { run, reused: false };
};

const lastActivityAt = async (run: AgentRun, db: Db): Promise<Date> => {
  const last = await db.agentRunEvent.findFirst({
    where: { runId: run.id },
    orderBy: { seq: "desc" },
    select: { createdAt: true },
  });
  return last?.createdAt ?? run.createdAt;
};

/**
 * The run a tool call belongs to. Throws RUN_NOT_FOUND for a missing run and
 * for another user's run alike, and RUN_CLOSED once the run is finished or
 * has been left alone for a day.
 */
export const loadOpenRun = async (
  userId: string,
  runId: string,
  db: Db = prisma
): Promise<AgentRun> => {
  const run = await db.agentRun.findFirst({ where: { id: runId, userId } });

  if (!run) throw RUN_NOT_FOUND();

  if (run.finishedAt || run.status !== RUN_STATUS.IN_PROGRESS) {
    throw RUN_CLOSED(run.status);
  }

  const idleMs = Date.now() - (await lastActivityAt(run, db)).getTime();
  if (idleMs > LIMITS.RUN_ABANDONED_AFTER_HOURS * 3_600_000) {
    // Uses the shared client on purpose: the caller's transaction is about to
    // be rolled back by the error below, and this must stay.
    await prisma.agentRun.updateMany({
      where: { id: run.id, status: RUN_STATUS.IN_PROGRESS },
      data: { status: RUN_STATUS.ABANDONED, finishedAt: new Date() },
    });
    throw RUN_CLOSED(RUN_STATUS.ABANDONED);
  }

  return run;
};

/** Refuses the call when the run already holds the maximum number of tool calls. */
export const assertRunHasRoom = async (runId: string, db: Db = prisma) => {
  const used = await db.agentRunEvent.count({ where: { runId } });
  if (used >= LIMITS.TOOL_CALLS_PER_RUN) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `This run has reached ${LIMITS.TOOL_CALLS_PER_RUN} tool calls.`,
      "Call finish_run with a summary of what is done, then start_run for the rest."
    );
  }
};

/**
 * Writes one event. Pass the transaction of the change it describes, so the
 * event and the change are saved together or not at all.
 *
 * The run row is locked first: two tool calls made at the same moment get
 * the numbers n and n+1, never the same number.
 */
export const recordRunEvent = async (
  db: Db,
  event: {
    runId: string;
    toolName: string;
    summary: string;
    ok: boolean;
    errorCode?: string | null;
    touched?: Touched[];
    detail?: Record<string, unknown> | null;
    durationMs?: number | null;
  }
): Promise<AgentRunEvent> => {
  const write = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT "id" FROM "agent_runs" WHERE "id" = ${event.runId} FOR UPDATE`;
    const last = await tx.agentRunEvent.aggregate({
      where: { runId: event.runId },
      _max: { seq: true },
    });

    return tx.agentRunEvent.create({
      data: {
        runId: event.runId,
        seq: (last._max.seq ?? 0) + 1,
        toolName: event.toolName,
        summary: event.summary.slice(0, 300),
        ok: event.ok,
        errorCode: event.errorCode ?? null,
        touched: (event.touched ?? []) as unknown as Prisma.InputJsonValue,
        detail: (event.detail ?? undefined) as Prisma.InputJsonValue | undefined,
        durationMs: event.durationMs ?? null,
        // The server's own clock, at the moment of writing. (The database
        // default would give the time the transaction started, which can be
        // earlier than a row the same call just changed.)
        createdAt: new Date(),
      },
    });
  };

  // `prisma` itself has $transaction; a transaction client does not.
  return "$transaction" in db
    ? (db as typeof prisma).$transaction(write)
    : write(db as Prisma.TransactionClient);
};

/**
 * Closes a run. Safe to call twice with the same summary. After this, every
 * write tool answers RUN_CLOSED for this run.
 */
export const finishRun = async (
  userId: string,
  runId: string,
  summary: string,
  db: Db = prisma
): Promise<{ run: AgentRun; alreadyFinished: boolean }> => {
  const text = summary.trim().slice(0, LIMITS.RUN_SUMMARY_MAX);
  const run = await db.agentRun.findFirst({ where: { id: runId, userId } });

  if (!run) throw RUN_NOT_FOUND();

  if (run.finishedAt) {
    if (
      run.status !== RUN_STATUS.ABANDONED &&
      run.status !== RUN_STATUS.FAILED &&
      (run.summary ?? "") === text
    ) {
      return { run, alreadyFinished: true };
    }
    throw RUN_CLOSED(run.status);
  }

  const awaiting = await db.sequence.count({
    where: { runId, userId, approvalStatus: "awaiting_approval", status: "draft" },
  });

  const updated = await db.agentRun.update({
    where: { id: run.id },
    data: {
      status:
        awaiting > 0 ? RUN_STATUS.AWAITING_APPROVAL : RUN_STATUS.COMPLETED,
      summary: text,
      finishedAt: new Date(),
    },
  });

  return { run: updated, alreadyFinished: false };
};

/**
 * Called when a person releases a sequence of a run. A run that was "awaiting
 * approval" becomes "completed" once none of its drafts is still waiting.
 */
export const refreshRunAfterApproval = async (runId: string, db: Db = prisma) => {
  const waiting = await db.sequence.count({
    where: { runId, status: "draft", approvalStatus: "awaiting_approval" },
  });
  if (waiting === 0) {
    await db.agentRun.updateMany({
      where: { id: runId, status: RUN_STATUS.AWAITING_APPROVAL },
      data: { status: RUN_STATUS.COMPLETED },
    });
  }
};

// ── reading runs (for the app and for Claude) ────────────────────────

type RunCounts = {
  sequences: number;
  awaiting_approval: number;
  active: number;
  paused: number;
  steps_sent: number;
  steps_failed: number;
  drafts_with_no_call_transcript: number;
};

const emptyCounts = (): RunCounts => ({
  sequences: 0,
  awaiting_approval: 0,
  active: 0,
  paused: 0,
  steps_sent: 0,
  steps_failed: 0,
  drafts_with_no_call_transcript: 0,
});

/** A sequence was written without a call transcript when no step is based on one. */
const writtenWithoutTranscript = (bases: (string | null)[]): boolean =>
  bases.includes("notes_and_stage") && !bases.includes("transcript");

const countsForRuns = async (
  userId: string,
  runIds: string[],
  db: Db
): Promise<Map<string, RunCounts>> => {
  const result = new Map<string, RunCounts>(runIds.map((id) => [id, emptyCounts()]));
  if (runIds.length === 0) return result;

  const sequences = await db.sequence.findMany({
    where: { userId, runId: { in: runIds } },
    select: { id: true, runId: true, status: true, approvalStatus: true },
  });
  if (sequences.length === 0) return result;

  const steps = await db.sequenceStep.groupBy({
    by: ["sequenceId", "status", "basis"],
    where: { sequenceId: { in: sequences.map((s) => s.id) } },
    _count: { _all: true },
  });

  const bySequence = new Map<string, { status: string; basis: string | null; count: number }[]>();
  for (const row of steps) {
    const list = bySequence.get(row.sequenceId) ?? [];
    list.push({ status: row.status, basis: row.basis, count: row._count._all });
    bySequence.set(row.sequenceId, list);
  }

  for (const sequence of sequences) {
    const counts = result.get(sequence.runId as string);
    if (!counts) continue;
    const rows = bySequence.get(sequence.id) ?? [];

    counts.sequences++;
    if (sequence.status === "active") counts.active++;
    if (sequence.status === "paused") counts.paused++;
    if (sequence.status === "draft" && sequence.approvalStatus === "awaiting_approval") {
      counts.awaiting_approval++;
    }
    for (const row of rows) {
      if (row.status === "sent") counts.steps_sent += row.count;
      if (row.status === "failed") counts.steps_failed += row.count;
    }
    if (
      sequence.status === "draft" &&
      writtenWithoutTranscript(rows.map((row) => row.basis))
    ) {
      counts.drafts_with_no_call_transcript++;
    }
  }

  return result;
};

const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

export const serializeRun = (run: AgentRun, counts?: RunCounts) => ({
  run_id: run.id,
  status: run.status,
  instruction: run.instruction,
  summary: run.summary,
  client: run.clientName,
  started_at: run.createdAt.toISOString(),
  finished_at: iso(run.finishedAt),
  ...(counts ? { counts } : {}),
});

/**
 * One event. An event's summary and the labels of what it touched can repeat
 * a lead's name, which someone else typed. For the app they are plain fields.
 * For Claude (`forClaude`) they are named `untrusted_…`, so that this text is
 * never mistaken for an instruction.
 */
export const serializeEvent = (event: AgentRunEvent, forClaude = false) => {
  const touched = Array.isArray(event.touched)
    ? (event.touched as { type?: string; id?: string; label?: string }[])
    : [];

  return {
    seq: event.seq,
    tool: event.toolName,
    ok: event.ok,
    error_code: event.errorCode,
    duration_ms: event.durationMs,
    at: event.createdAt.toISOString(),
    ...(forClaude
      ? {
          untrusted_summary: event.summary,
          touched: touched.map((t) => ({
            type: t.type,
            id: t.id,
            ...(t.label ? { untrusted_label: t.label } : {}),
          })),
        }
      : { summary: event.summary, touched }),
  };
};

/** Runs a day old and still "in progress" are shown as abandoned. */
const closeAbandonedRuns = async (userId: string, db: Db) => {
  const cutoff = new Date(
    Date.now() - LIMITS.RUN_ABANDONED_AFTER_HOURS * 3_600_000
  );
  const stale = await db.agentRun.findMany({
    where: { userId, status: RUN_STATUS.IN_PROGRESS, createdAt: { lt: cutoff } },
    select: { id: true, events: { orderBy: { seq: "desc" }, take: 1, select: { createdAt: true } } },
  });
  const ids = stale
    .filter((run) => !run.events[0] || run.events[0].createdAt < cutoff)
    .map((run) => run.id);

  if (ids.length > 0) {
    await db.agentRun.updateMany({
      where: { id: { in: ids }, status: RUN_STATUS.IN_PROGRESS },
      data: { status: RUN_STATUS.ABANDONED, finishedAt: new Date() },
    });
  }
};

export const listRuns = async (
  userId: string,
  query: { status?: string; page?: number; limit?: number },
  db: Db = prisma
) => {
  await closeAbandonedRuns(userId, db);

  const page = Math.max(1, Math.floor(query.page || 1));
  const limit = Math.min(
    LIMITS.PAGE_SIZE_MAX,
    Math.max(1, Math.floor(query.limit || LIMITS.PAGE_SIZE_DEFAULT))
  );
  const where: Prisma.AgentRunWhereInput = { userId };
  if (query.status) where.status = query.status;

  const [runs, total] = await Promise.all([
    db.agentRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    db.agentRun.count({ where }),
  ]);

  const counts = await countsForRuns(userId, runs.map((r) => r.id), db);

  return {
    items: runs.map((run) => serializeRun(run, counts.get(run.id))),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
};

const loadRun = async (userId: string, runId: string, db: Db): Promise<AgentRun> => {
  const run = await db.agentRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw RUN_NOT_FOUND();
  return run;
};

export const getRunEvents = async (
  userId: string,
  runId: string,
  options: { after?: number; limit?: number; forClaude?: boolean } = {},
  db: Db = prisma
) => {
  await loadRun(userId, runId, db);
  const after = Math.max(0, Math.floor(options.after || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit || LIMITS.RUN_EVENTS_PER_READ)));

  const events = await db.agentRunEvent.findMany({
    where: { runId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit + 1,
  });
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;

  return {
    events: page.map((event) => serializeEvent(event, options.forClaude === true)),
    last_seq: page.length > 0 ? page[page.length - 1].seq : after,
    has_more: hasMore,
  };
};

const CHANNEL: Record<string, string> = {
  EMAIL: "email",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  CALL: "call",
};

/** A step's date means something only once the sequence has been approved. */
const HAS_REAL_DATE = new Set(["scheduled", "sending", "calling", "sent", "failed", "skipped"]);

/**
 * Sequences of a run with their steps and LIVE status.
 *
 * `withText: true` adds each step's subject and body (for the app's review
 * screen). Without it the result stays small enough for a tool answer.
 *
 * A lead's name and company were typed or imported by someone else, so they
 * are returned inside an `untrusted` object, and a meeting title as
 * `untrusted_meeting_title`. They are data, never instructions.
 */
export const getRunSequences = async (
  userId: string,
  runId: string,
  options: { page?: number; limit?: number; withText?: boolean; forClaude?: boolean } = {},
  db: Db = prisma
) => {
  await loadRun(userId, runId, db);

  const page = Math.max(1, Math.floor(options.page || 1));
  const limit = Math.min(
    LIMITS.PAGE_SIZE_MAX,
    Math.max(1, Math.floor(options.limit || LIMITS.PAGE_SIZE_DEFAULT))
  );
  const where = { userId, runId };

  const [sequences, total] = await Promise.all([
    db.sequence.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        lead: {
          select: {
            id: true,
            name: true,
            company: true,
            doNotContact: true,
            _count: { select: { transcripts: true } },
          },
        },
        steps: { orderBy: { stepOrder: "asc" } },
      },
    }),
    db.sequence.count({ where }),
  ]);

  const transcriptIds = new Set<string>();
  for (const sequence of sequences) {
    for (const step of sequence.steps) {
      if (Array.isArray(step.basedOnTranscriptIds)) {
        for (const id of step.basedOnTranscriptIds) {
          if (typeof id === "string") transcriptIds.add(id);
        }
      }
    }
  }

  const transcripts =
    transcriptIds.size > 0
      ? await db.leadTranscript.findMany({
          where: { userId, id: { in: [...transcriptIds] } },
          select: { id: true, meetingDate: true, meetingTitle: true },
        })
      : [];
  const transcriptById = new Map(transcripts.map((t) => [t.id, t]));

  const items = sequences.map((sequence) => {
    const noCallTranscript = writtenWithoutTranscript(
      sequence.steps.map((step) => step.basis)
    );

    return {
      sequence_id: sequence.id,
      // A sequence name often repeats the lead's name: labelled for Claude.
      ...(options.forClaude
        ? { untrusted_name: sequence.name }
        : { name: sequence.name }),
      status: sequence.status,
      approval_status: sequence.approvalStatus,
      approved_at: iso(sequence.approvedAt),
      paused_reason: sequence.status === "paused" ? sequence.pausedReason : null,
      no_call_transcript: noCallTranscript,
      transcript_added_since: noCallTranscript && sequence.lead._count.transcripts > 0,
      lead: {
        lead_id: sequence.lead.id,
        do_not_contact: sequence.lead.doNotContact,
        untrusted: { name: sequence.lead.name, company: sequence.lead.company },
      },
      steps: sequence.steps.map((step) => {
        const ids = Array.isArray(step.basedOnTranscriptIds)
          ? step.basedOnTranscriptIds.filter((id): id is string => typeof id === "string")
          : [];

        return {
          step_id: step.id,
          step_number: step.stepOrder,
          channel: CHANNEL[step.stepType] ?? step.stepType.toLowerCase(),
          status: step.status,
          delay_days:
            step.delayMinutes === null
              ? null
              : Math.round((step.delayMinutes / 1440) * 100) / 100,
          scheduled_for: HAS_REAL_DATE.has(step.status) ? iso(step.scheduledAt) : null,
          sent_at: iso(step.sentAt),
          delivery_mode: step.deliveryMode,
          ...(options.withText
            ? { subject: step.subject, body: step.content, send_log: step.sendLog }
            : {}),
          based_on: {
            kind: step.basis ?? "not_stated",
            transcripts: ids
              .map((id) => transcriptById.get(id))
              .filter((t): t is NonNullable<typeof t> => Boolean(t))
              .map((t) => ({
                id: t.id,
                meeting_date: t.meetingDate.toISOString().slice(0, 10),
                untrusted_meeting_title: t.meetingTitle,
              })),
            note: step.basedOnNote,
          },
        };
      }),
    };
  });

  return {
    items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
};

export const getRun = async (userId: string, runId: string, db: Db = prisma) => {
  const run = await loadRun(userId, runId, db);
  const counts = await countsForRuns(userId, [run.id], db);
  return serializeRun(run, counts.get(run.id));
};

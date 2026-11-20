import { LIMITS } from "../../harness/limits";
import {
  describeRunContext,
  finishRun,
  getRun,
  getRunEvents,
  getRunSequences,
  listRuns,
  RUN_STATUS,
  serializeRun,
  startRun,
} from "../../harness/runs/run.service";
import { defineTool, type HarnessTool } from "../tool-kit";
import { z } from "../zod";
import { page, UNTRUSTED_NOTE } from "./shared";

/**
 * The four run tools (MCP_DESIGN.md, section 6.2).
 *
 * Inputs are strict: a field that is not listed is rejected. No tool here can
 * send a message or activate a sequence.
 */

const runId = z.string().uuid().describe("The run_id returned by start_run.");

const shorten = (text: string | null, max: number): string | null =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

export const startRunTool = defineTool({
  name: "start_run",
  title: "Start a run",
  kind: "write",
  run: "none",
  description:
    "Call this FIRST for every new instruction from the user, before any other tool. " +
    "It opens a run: the record of everything you do for that instruction, which the user sees in the Touchbase app. " +
    "Pass the user's instruction in their own words. It returns the run_id that every write tool needs, " +
    "the limits, the user's send window, and warnings you must pass on to the user " +
    "(for example that no timezone is set). Calling it again with the same instruction returns the same run.",
  input: z.strictObject({
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.INSTRUCTION_MAX)
      .describe("The user's instruction, in their own words (1 to 2,000 characters)."),
  }),
  handler: async (input, { actor, db }) => {
    const { run, reused } = await startRun(actor, input, db);
    const context = await describeRunContext(actor.userId, db);

    return {
      result: {
        run_id: run.id,
        status: run.status,
        started_at: run.createdAt.toISOString(),
        same_run_as_before: reused,
        ...context,
      },
      summary: reused
        ? "start_run was called again with the same instruction: the same run was returned"
        : "Run started",
      touched: [{ type: "run", id: run.id }],
      eventRunId: run.id,
    };
  },
});

export const getRunTool = defineTool({
  name: "get_run",
  title: "Get a run",
  kind: "read",
  run: "none",
  description:
    "Use this to check or report what a run did: its status, the tool calls made in it, " +
    "and its sequences with the live status of every step and what each message was based on. " +
    "Message text is not included. Events and sequences come in pages. " +
    UNTRUSTED_NOTE,
  input: z.strictObject({
    run_id: runId,
    events_after: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Return only events with a number higher than this. Use last_seq from the previous answer."),
    sequences_page: z.number().int().min(1).optional().describe("Page of sequences, starting at 1."),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.RUN_SEQUENCES_PER_READ_MAX)
      .optional()
      .describe(`Sequences per page (default ${LIMITS.RUN_SEQUENCES_PER_READ}, at most ${LIMITS.RUN_SEQUENCES_PER_READ_MAX}).`),
  }),
  handler: async (input, { actor, db }) => {
    const run = await getRun(actor.userId, input.run_id, db);
    const events = await getRunEvents(
      actor.userId,
      input.run_id,
      { after: input.events_after, limit: LIMITS.RUN_EVENTS_PER_READ, forClaude: true },
      db
    );
    const sequences = await getRunSequences(
      actor.userId,
      input.run_id,
      {
        page: input.sequences_page,
        limit: input.page_size ?? LIMITS.RUN_SEQUENCES_PER_READ,
        withText: false,
        forClaude: true,
      },
      db
    );

    return {
      result: { run, events, sequences },
      summary: "Read the run",
    };
  },
});

export const listRunsTool = defineTool({
  name: "list_runs",
  title: "List runs",
  kind: "read",
  run: "none",
  description:
    "Use this when the user asks about earlier instructions: what was asked, when, and how far each one got. " +
    "Returns runs, newest first, with counts of sequences, drafts awaiting approval, active sequences, " +
    "and messages sent or failed.",
  input: z.strictObject({
    status: z
      .enum([
        RUN_STATUS.IN_PROGRESS,
        RUN_STATUS.AWAITING_APPROVAL,
        RUN_STATUS.COMPLETED,
        RUN_STATUS.FAILED,
        RUN_STATUS.ABANDONED,
      ])
      .optional()
      .describe("Only runs with this status."),
    page,
    page_size: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.RUN_SEQUENCES_PER_READ_MAX)
      .optional()
      .describe(`Runs per page (default ${LIMITS.PAGE_SIZE_DEFAULT}, at most ${LIMITS.RUN_SEQUENCES_PER_READ_MAX}).`),
  }),
  handler: async (input, { actor, db }) => {
    const page = await listRuns(
      actor.userId,
      { status: input.status, page: input.page, limit: input.page_size },
      db
    );

    return {
      result: {
        runs: page.items.map((run) => ({
          ...run,
          instruction: shorten(run.instruction, 300),
          summary: shorten(run.summary, 300),
        })),
        pagination: page.pagination,
      },
      summary: "Listed runs",
    };
  },
});

export const finishRunTool = defineTool({
  name: "finish_run",
  title: "Finish a run",
  kind: "write",
  run: "none",
  description:
    "Call this LAST, when the work for the user's instruction is done (after request_approval, if you prepared drafts). " +
    "Pass a short summary for the user: what you prepared and what is waiting for them. " +
    "It closes the run: after it, no tool can write in this run. A new instruction needs a new start_run. " +
    "Calling it again with the same summary changes nothing.",
  input: z.strictObject({
    run_id: runId,
    summary: z
      .string()
      .trim()
      .min(1)
      .max(LIMITS.RUN_SUMMARY_MAX)
      .describe("What was done, in plain words for the user (at most 500 characters)."),
  }),
  handler: async (input, { actor, db }) => {
    const { run, alreadyFinished } = await finishRun(
      actor.userId,
      input.run_id,
      input.summary,
      db
    );

    return {
      result: { ...serializeRun(run), already_finished: alreadyFinished },
      summary: "Run finished",
      touched: [{ type: "run", id: run.id }],
      // A run that was already closed gets no new event.
      eventRunId: alreadyFinished ? null : run.id,
    };
  },
});

export const RUN_TOOLS: HarnessTool<any>[] = [
  startRunTool,
  getRunTool,
  listRunsTool,
  finishRunTool,
];

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { Prisma, type AgentRun } from "@prisma/client";
import prisma from "../shared/prisma";
import AppError from "../shared/errors/AppError";
import type { Actor } from "../harness/actor";
import {
  HarnessError,
  type HarnessErrorCode,
  type HarnessOutcome,
  isHarnessError,
} from "../harness/errors";
import { LIMITS } from "../harness/limits";
import { checkRateLimit } from "../harness/rate-limit";
import {
  assertRunHasRoom,
  loadOpenRun,
  recordRunEvent,
  type Touched,
} from "../harness/runs/run.service";
import type { z } from "./zod";

/**
 * The one wrapper every MCP tool goes through.
 *
 * Because every tool passes here, none of these can be forgotten in a single tool:
 *   1. the rate limit of the access token;
 *   2. the run: it must exist, belong to this user, and still be open;
 *   3. one database transaction for the tool's work and its run event, so the
 *      record of what Claude did is saved together with the change, or not at all;
 *   4. one answer shape, and one error shape with a code, a message and a next step;
 *   5. a size limit on every answer.
 *
 * Input checking (unknown fields are rejected) is done by the SDK against the
 * tool's strict schema before the handler runs.
 */

export type ToolContext = {
  /** Who is acting. Comes from the access token, never from the tool input. */
  actor: Actor;
  /** The transaction of this call. Use it for every read and write. */
  db: Prisma.TransactionClient;
  /** The open run this call belongs to, when the tool takes a run_id. */
  run: AgentRun | null;
};

export type ToolOutcome = HarnessOutcome & {
  /**
   * Only for the tools that open or close a run themselves (start_run,
   * finish_run): the run their own event belongs to.
   */
  eventRunId?: string | null;
};

export type HarnessTool<Schema extends z.ZodType = z.ZodType> = {
  name: string;
  title: string;
  description: string;
  /** "read" tools change nothing. "write" tools are safe to call twice. */
  kind: "read" | "write";
  /** Marks remove_step and stop_sequence. */
  destructive?: boolean;
  /**
   * "required": the input has run_id and the run must be open (every write tool).
   * "optional": run_id may be given; if it is, the call is recorded in that run.
   * "none":     the tool handles the run itself (the four run tools).
   */
  run: "required" | "optional" | "none";
  input: Schema;
  handler: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolOutcome>;
};

/** Keeps the handler's input type tied to its schema. */
export const defineTool = <Schema extends z.ZodType>(
  tool: HarnessTool<Schema>
): HarnessTool<Schema> => tool;

/** The only codes an error from the existing services or Prisma is turned into. */
type AppErrorCode = Extract<HarnessErrorCode, "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "INTERNAL">;

const NEXT_STEP_FOR_APP_ERROR: Record<AppErrorCode, string> = {
  NOT_FOUND: "Check the id. Use a search or list tool to find the right record.",
  CONFLICT: "Read the current state of the record, then decide whether a change is still needed.",
  VALIDATION: "Correct the input and call the tool again.",
  INTERNAL: "Try once more. If it fails again, tell the user and stop.",
};

const fromStatus = (status: number): AppErrorCode =>
  status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 400 ? "VALIDATION" : "INTERNAL";

/** Turns anything that was thrown into the one error shape Claude gets. */
const toHarnessError = (error: unknown, toolName: string): HarnessError => {
  if (isHarnessError(error)) return error;

  // Errors of the existing services. Their messages are written for app users
  // and carry no secrets.
  if (error instanceof AppError) {
    const code = fromStatus(error.statusCode);
    if (code !== "INTERNAL") {
      return new HarnessError(code, error.message, NEXT_STEP_FOR_APP_ERROR[code]);
    }
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return new HarnessError(
        "CONFLICT",
        "A record with these values already exists.",
        NEXT_STEP_FOR_APP_ERROR.CONFLICT
      );
    }
    if (error.code === "P2025") {
      return new HarnessError(
        "NOT_FOUND",
        "The record was not found.",
        NEXT_STEP_FOR_APP_ERROR.NOT_FOUND
      );
    }
  }

  // Unknown: log the detail on the server, tell Claude nothing about the inside.
  console.error(`[MCP] ${toolName} failed:`, error);
  return new HarnessError(
    "INTERNAL",
    "Something went wrong inside Touchbase. Nothing was changed by this call.",
    NEXT_STEP_FOR_APP_ERROR.INTERNAL
  );
};

const success = (result: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});

const failure = (error: HarnessError): CallToolResult => {
  const payload = {
    error: {
      code: error.code,
      message: error.message,
      next_step: error.nextStep,
      ...error.extra,
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
};

const assertFits = (result: Record<string, unknown>): void => {
  const size = JSON.stringify(result).length;
  if (size > LIMITS.TOOL_RESULT_MAX_CHARS) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `The answer would be ${size} characters; the limit is ${LIMITS.TOOL_RESULT_MAX_CHARS}.`,
      "Ask for less at a time: a smaller page_size, or a narrower filter."
    );
  }
};

/** Runs one tool call from start to finish. Never throws: errors become answers. */
export const runTool = async <Schema extends z.ZodType>(
  actor: Actor,
  tool: HarnessTool<Schema>,
  input: z.infer<Schema>
): Promise<CallToolResult> => {
  const startedAt = Date.now();
  /** Filled once the run is known to be open, so a failure can be recorded in it. */
  const state: { openRunId: string | null } = { openRunId: null };

  try {
    const rate = checkRateLimit(actor.tokenId);
    if (!rate.ok) {
      throw new HarnessError(
        "RATE_LIMITED",
        `Too many tool calls: at most ${LIMITS.TOOL_CALLS_PER_MINUTE} per minute.`,
        `Wait ${rate.retryAfterSeconds} seconds, then continue.`
      );
    }

    const requestedRunId =
      tool.run === "none"
        ? null
        : ((input as { run_id?: string | null } | null)?.run_id ?? null);

    if (tool.run === "required" && !requestedRunId) {
      throw new HarnessError(
        "VALIDATION",
        "run_id is required for this tool.",
        "Call start_run first and pass the run_id it returns."
      );
    }

    const outcome = await prisma.$transaction(
      async (tx) => {
        let run: AgentRun | null = null;

        if (requestedRunId) {
          run = await loadOpenRun(actor.userId, requestedRunId, tx);
          await assertRunHasRoom(run.id, tx);
          state.openRunId = run.id;
        }

        const result = await tool.handler(input, { actor, db: tx, run });
        assertFits(result.result);

        const eventRunId = run?.id ?? result.eventRunId ?? null;
        if (eventRunId) {
          await recordRunEvent(tx, {
            runId: eventRunId,
            toolName: tool.name,
            summary: result.summary,
            ok: true,
            touched: result.touched,
            detail: result.detail,
            durationMs: Date.now() - startedAt,
          });
        }

        return result;
      },
      { maxWait: 10_000, timeout: 60_000 }
    );

    return success(outcome.result);
  } catch (error) {
    const harnessError = toHarnessError(error, tool.name);

    // The transaction was rolled back, so nothing the tool did was saved.
    // The failed call itself is still part of what Claude did: record it.
    if (state.openRunId) {
      await recordRunEvent(prisma, {
        runId: state.openRunId,
        toolName: tool.name,
        summary: `Failed: ${harnessError.message}`,
        ok: false,
        errorCode: harnessError.code,
        durationMs: Date.now() - startedAt,
      }).catch(() => {});
    }

    return failure(harnessError);
  }
};

/** Registers a tool on a server built for one actor. */
export const registerHarnessTool = <Schema extends z.ZodType>(
  server: McpServer,
  actor: Actor,
  tool: HarnessTool<Schema>
): void => {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      annotations:
        tool.kind === "read"
          ? { readOnlyHint: true, openWorldHint: false }
          : {
              readOnlyHint: false,
              idempotentHint: true,
              destructiveHint: tool.destructive ?? false,
              openWorldHint: false,
            },
    },
    (async (args: z.infer<Schema>) => runTool(actor, tool, args)) as never
  );
};

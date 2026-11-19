// The wrapper every tool goes through: the run check, one transaction for the
// work and its event, the error shape, and the limits. Tested with small
// stand-in tools, so the rules are proven before the real tools exist.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeAccessToken, makeRun, makeUser, prisma, resetDb } from "./helpers/setup";
import AppError from "../src/shared/errors/AppError";
import type { Actor } from "../src/harness/actor";
import { HarnessError } from "../src/harness/errors";
import { LIMITS } from "../src/harness/limits";
import { resetRateLimits } from "../src/harness/rate-limit";
import { recordRunEvent } from "../src/harness/runs/run.service";
import { defineTool, runTool } from "../src/mcp/tool-kit";
import { z } from "../src/mcp/zod";

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
});
after(() => prisma.$disconnect());

const setup = async () => {
  const user = await makeUser();
  const { id: tokenId } = await makeAccessToken(user.id);
  const actor: Actor = { userId: user.id, tokenId, actor: "mcp", clientName: "tests" };
  const run = await makeRun(user.id);
  await recordRunEvent(prisma, { runId: run.id, toolName: "start_run", summary: "Run started", ok: true });
  return { user, actor, run };
};

const eventsOf = (runId: string) =>
  prisma.agentRunEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } });

const structured = (result: { structuredContent?: unknown }) => result.structuredContent as any;

let handlerCalls = 0;

/** A stand-in write tool: saves a goal label, then does what `then` says. */
const writeTool = defineTool({
  name: "test_write",
  title: "Test write",
  description: "Saves a goal label (test only).",
  kind: "write",
  run: "required",
  input: z.strictObject({
    run_id: z.string().uuid(),
    label: z.string(),
    then: z.enum(["ok", "harness_error", "app_error_404", "crash", "huge"]).optional(),
  }),
  handler: async (input, { actor, db }) => {
    handlerCalls++;
    const goal = await db.sequenceGoal.create({
      data: { userId: actor.userId, label: input.label },
    });

    if (input.then === "harness_error") {
      throw new HarnessError("DO_NOT_CONTACT", "This lead is marked do-not-contact.", "Leave this lead out.");
    }
    if (input.then === "app_error_404") throw new AppError(404, "Lead not found");
    if (input.then === "crash") throw new Error("SECRET-INTERNAL-DETAIL connection string");

    return {
      result: {
        goal_id: goal.id,
        ...(input.then === "huge" ? { filler: "x".repeat(LIMITS.TOOL_RESULT_MAX_CHARS + 1) } : {}),
      },
      summary: `Saved the goal "${input.label}"`,
      touched: [{ type: "goal", id: goal.id, label: input.label }],
      detail: { label_length: input.label.length },
    };
  },
});

const readTool = defineTool({
  name: "test_read",
  title: "Test read",
  description: "Counts goals (test only).",
  kind: "read",
  run: "optional",
  input: z.strictObject({ run_id: z.string().uuid().optional() }),
  handler: async (_input, { actor, db }) => {
    handlerCalls++;
    return {
      result: { goals: await db.sequenceGoal.count({ where: { userId: actor.userId } }) },
      summary: "Counted the goals",
    };
  },
});

const goalCount = (userId: string) => prisma.sequenceGoal.count({ where: { userId } });

test("a successful write: the change and its event are saved together", async () => {
  const { user, actor, run } = await setup();
  handlerCalls = 0;

  const result = await runTool(actor, writeTool, { run_id: run.id, label: "Book a call" });

  assert.equal(result.isError, undefined);
  assert.equal(await goalCount(user.id), 1);
  const events = await eventsOf(run.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].seq, 2);
  assert.equal(events[1].toolName, "test_write");
  assert.equal(events[1].ok, true);
  assert.equal(events[1].summary, 'Saved the goal "Book a call"');
  assert.deepEqual(events[1].touched, [
    { type: "goal", id: structured(result).goal_id, label: "Book a call" },
  ]);
  assert.deepEqual(events[1].detail, { label_length: 11 });
  assert.ok((events[1].durationMs ?? -1) >= 0);
});

test("a refused write: nothing the tool did is kept, and the refusal is recorded", async () => {
  const { user, actor, run } = await setup();

  const result = await runTool(actor, writeTool, {
    run_id: run.id,
    label: "Should not stay",
    then: "harness_error",
  });

  assert.equal(result.isError, true);
  assert.deepEqual(structured(result), {
    error: {
      code: "DO_NOT_CONTACT",
      message: "This lead is marked do-not-contact.",
      next_step: "Leave this lead out.",
    },
  });
  assert.equal(await goalCount(user.id), 0, "the write was rolled back");

  const events = await eventsOf(run.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].errorCode, "DO_NOT_CONTACT");
  assert.match(events[1].summary, /^Failed: /);
});

test("an error of an existing service keeps its message and gets a code", async () => {
  const { actor, run } = await setup();

  const result = await runTool(actor, writeTool, { run_id: run.id, label: "x", then: "app_error_404" });

  assert.equal(structured(result).error.code, "NOT_FOUND");
  assert.equal(structured(result).error.message, "Lead not found");
  assert.ok(structured(result).error.next_step.length > 10);
});

test("an unexpected crash tells Claude nothing about the inside, and is rolled back", async () => {
  const { user, actor, run } = await setup();
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  let result;
  try {
    result = await runTool(actor, writeTool, { run_id: run.id, label: "x", then: "crash" });
  } finally {
    console.error = original;
  }

  assert.equal(result.isError, true);
  assert.equal(structured(result).error.code, "INTERNAL");
  assert.equal(JSON.stringify(result).includes("SECRET-INTERNAL-DETAIL"), false);
  assert.equal(await goalCount(user.id), 0);
  assert.ok(logged.some((line) => line.includes("SECRET-INTERNAL-DETAIL")), "the detail is in the server log");

  const events = await eventsOf(run.id);
  assert.equal(events[1].errorCode, "INTERNAL");
  assert.equal(events[1].summary.includes("SECRET-INTERNAL-DETAIL"), false);
});

test("an answer over the size limit is refused and nothing is kept", async () => {
  const { user, actor, run } = await setup();

  const result = await runTool(actor, writeTool, { run_id: run.id, label: "x", then: "huge" });

  assert.equal(structured(result).error.code, "LIMIT_EXCEEDED");
  assert.equal(await goalCount(user.id), 0);
});

test("a write tool does not run without an open run of this user", async () => {
  const { user, actor, run } = await setup();
  const stranger = await makeUser();
  const strangersRun = await makeRun(stranger.id);
  const finished = await makeRun(user.id, { status: "completed", finishedAt: new Date() });
  handlerCalls = 0;

  const cases: [Record<string, unknown>, string][] = [
    [{ label: "x" }, "VALIDATION"], // no run_id
    [{ run_id: randomUUID(), label: "x" }, "RUN_NOT_FOUND"],
    [{ run_id: strangersRun.id, label: "x" }, "RUN_NOT_FOUND"],
    [{ run_id: finished.id, label: "x" }, "RUN_CLOSED"],
  ];

  for (const [input, code] of cases) {
    const result = await runTool(actor, writeTool, input as never);
    assert.equal(structured(result).error.code, code, JSON.stringify(input));
  }

  assert.equal(handlerCalls, 0, "the tool itself never ran");
  assert.equal(await goalCount(user.id), 0);
  assert.equal((await eventsOf(strangersRun.id)).length, 0, "nothing is written into another user's run");
  assert.equal((await eventsOf(finished.id)).length, 0, "nothing is written into a closed run");
  assert.equal((await eventsOf(run.id)).length, 1);
});

test("a run left alone for a day is closed as abandoned", async () => {
  const { user, actor } = await setup();
  const old = await makeRun(user.id, { createdAt: new Date(Date.now() - 25 * 3_600_000) });

  const result = await runTool(actor, writeTool, { run_id: old.id, label: "x" });

  assert.equal(structured(result).error.code, "RUN_CLOSED");
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: old.id } });
  assert.equal(after.status, "abandoned");
  assert.ok(after.finishedAt);
});

test("a read is recorded only when it is given a run_id", async () => {
  const { actor, run } = await setup();

  const without = await runTool(actor, readTool, {});
  assert.equal(without.isError, undefined);
  assert.equal((await eventsOf(run.id)).length, 1);

  const withRun = await runTool(actor, readTool, { run_id: run.id });
  assert.equal(withRun.isError, undefined);
  const events = await eventsOf(run.id);
  assert.equal(events.length, 2);
  assert.equal(events[1].toolName, "test_read");
});

test("eight tool calls at the same moment get eight different numbers, in order", async () => {
  const { user, actor, run } = await setup();

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      runTool(actor, writeTool, { run_id: run.id, label: `Goal ${i}` })
    )
  );

  assert.equal(results.filter((r) => r.isError).length, 0);
  assert.equal(await goalCount(user.id), 8);
  const events = await eventsOf(run.id);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
});

test("a run holds at most N tool calls: call N is recorded, call N+1 is refused", async () => {
  const { user, actor, run } = await setup();
  const original = LIMITS.TOOL_CALLS_PER_RUN;
  LIMITS.TOOL_CALLS_PER_RUN = 3; // the start event is number 1
  handlerCalls = 0;

  try {
    assert.equal((await runTool(actor, writeTool, { run_id: run.id, label: "two" })).isError, undefined);
    assert.equal((await runTool(actor, writeTool, { run_id: run.id, label: "three" })).isError, undefined);
    const over = await runTool(actor, writeTool, { run_id: run.id, label: "four" });
    assert.equal(structured(over).error.code, "LIMIT_EXCEEDED");
    assert.match(structured(over).error.next_step, /finish_run/);
  } finally {
    LIMITS.TOOL_CALLS_PER_RUN = original;
  }

  assert.equal(handlerCalls, 2);
  assert.equal(await goalCount(user.id), 2);
  assert.equal((await eventsOf(run.id)).length, 3, "the refused call adds no event");
});

test("the rate limit comes first: over it, the tool does not run", async () => {
  const { user, actor, run } = await setup();
  const original = LIMITS.TOOL_CALLS_PER_MINUTE;
  LIMITS.TOOL_CALLS_PER_MINUTE = 1;
  handlerCalls = 0;

  try {
    await runTool(actor, writeTool, { run_id: run.id, label: "one" });
    const over = await runTool(actor, writeTool, { run_id: run.id, label: "two" });
    assert.equal(structured(over).error.code, "RATE_LIMITED");
  } finally {
    LIMITS.TOOL_CALLS_PER_MINUTE = original;
  }

  assert.equal(handlerCalls, 1);
  assert.equal(await goalCount(user.id), 1);
});

// The send job as an endpoint (/api/v1/internal/send-tick), for hosts with no
// always-running process (Vercel). Modelled on the real case: a sequence made
// through Claude, approved in the app, workspace in Asia/Dhaka with the send
// window 09:00-18:00 on weekdays, a step due on Friday 20 Nov 2026 at 16:09
// local time that was never looked at.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  apiClient,
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  spySenders,
  startApp,
  withEnv,
} from "./helpers/setup";
import { makeSendJobRoutes } from "../src/harness/send-job.route";
import { runSendTick, type Senders } from "../src/shared/services/send-processor";
import { currentApprovalHash } from "../src/harness/approval";

beforeEach(resetDb);
after(() => prisma.$disconnect());

const SECRET = "test-cron-secret-" + randomUUID();

// Friday 20 Nov 2026, 10:09:59 UTC = 16:09 in Dhaka: when the step was due.
const DUE_AT = new Date("2026-11-20T10:09:59.364Z");
// Friday 11:45 UTC = 17:45 in Dhaka: still inside the window, 1.5 h overdue.
const FRIDAY_INSIDE = new Date("2026-11-20T11:45:00Z");
// Friday 13:00 UTC = 19:00 in Dhaka: after the window closed.
const FRIDAY_AFTER = new Date("2026-11-20T13:00:00Z");
// Monday 23 Nov 2026, 09:00 in Dhaka: the next time the window opens (weekends off).
const MONDAY_OPENS = new Date("2026-11-23T03:00:00Z");

/** A sequence made through Claude (it has a run), approved by a person, with its steps. */
const seedApproved = async (
  steps: { stepType: "EMAIL" | "SMS"; scheduledAt: Date }[]
) => {
  const user = await makeUser();
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      sendTimezone: "Asia/Dhaka",
      sendWindowStart: "09:00",
      sendWindowEnd: "18:00",
      sendOnWeekends: false,
    },
  });
  const lead = await makeLead(user.id);
  const sequence = await makeSequence(user.id, lead.id, {
    runId: randomUUID(),
    totalSteps: steps.length,
  });
  const made = [];
  for (const [index, step] of steps.entries()) {
    made.push(
      await makeStep(sequence.id, {
        stepOrder: index + 1,
        stepType: step.stepType,
        subject: step.stepType === "EMAIL" ? "Following up" : null,
        scheduledAt: step.scheduledAt,
      })
    );
  }
  await prisma.sequence.update({
    where: { id: sequence.id },
    data: {
      approvalStatus: "approved",
      approvedAt: new Date(DUE_AT.getTime() - 1000),
      approvedByUserId: user.id,
      approvedContentHash: await currentApprovalHash(sequence.id),
    },
  });
  return { user, lead, sequence, steps: made };
};

/** Just the send-job routes on a free port, with fake providers and a fixed clock. */
const startJob = async (options: { senders?: Senders; now: () => Date }) => {
  const app = express();
  app.use("/api/v1/internal", makeSendJobRoutes(options));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const call = apiClient(`http://127.0.0.1:${port}/api/v1`, SECRET);
  return {
    tick: () => call("POST", "/internal/send-tick"),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const withJob = async <T>(
  options: { senders?: Senders; now: () => Date },
  run: (job: Awaited<ReturnType<typeof startJob>>) => Promise<T>
): Promise<T> =>
  withEnv({ CRON_SECRET: SECRET, OUTBOUND_MODE: undefined }, async () => {
    const job = await startJob(options);
    try {
      return await run(job);
    } finally {
      await job.close();
    }
  });

const stepNow = (id: string) => prisma.sequenceStep.findUniqueOrThrow({ where: { id } });
const events = (sequenceId: string, eventType: string) =>
  prisma.sequenceActivity.findMany({ where: { sequenceId, eventType } });

/** Captures console.error while `run` runs. */
const captureErrors = async <T>(run: () => Promise<T>) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
};

// ── the endpoint is closed unless set up ─────────────────────────────

test("the endpoint is off without CRON_SECRET, and refuses a wrong secret", async () => {
  const app = await startApp();
  try {
    await withEnv({ CRON_SECRET: undefined }, async () => {
      const res = await apiClient(app.url, SECRET)("POST", "/internal/send-tick");
      assert.equal(res.status, 404);
    });
    await withEnv({ CRON_SECRET: SECRET }, async () => {
      assert.equal((await apiClient(app.url)("POST", "/internal/send-tick")).status, 401);
      assert.equal(
        (await apiClient(app.url, "wrong-secret")("GET", "/internal/send-tick")).status,
        401
      );
    });
  } finally {
    await app.close();
  }
});

// ── 1. a due step inside the window is sent (caught up when overdue) ──

test("an overdue email step is sent on the next pass inside the window, once, with a sent event", async () => {
  const { sequence, steps } = await seedApproved([{ stepType: "EMAIL", scheduledAt: DUE_AT }]);
  const { senders, calls } = spySenders();

  await withJob({ senders, now: () => FRIDAY_INSIDE }, async (job) => {
    const res = await job.tick();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.due, 1);
    assert.equal(res.body.data.sent, 1);
    assert.equal(res.body.data.errors, 0);

    // a second pass finds nothing to do
    const again = await job.tick();
    assert.equal(again.body.data.due, 0);
  });

  assert.equal(calls.length, 1, "the provider is called exactly once");
  const step = await stepNow(steps[0].id);
  assert.equal(step.status, "sent");
  assert.ok(step.sentAt);
  assert.equal((await events(sequence.id, "step_sent")).length, 1);
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } })).status,
    "completed"
  );
});

// ── 2. a due step outside the window waits for the next window ───────

test("a due step outside the window is not sent; it moves to Monday 09:00 Dhaka and goes then", async () => {
  const { sequence, steps } = await seedApproved([{ stepType: "SMS", scheduledAt: DUE_AT }]);
  const { senders, calls } = spySenders();

  await withJob({ senders, now: () => FRIDAY_AFTER }, async (job) => {
    const res = await job.tick();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.waiting, 1);
  });

  assert.equal(calls.length, 0);
  let step = await stepNow(steps[0].id);
  assert.equal(step.status, "scheduled");
  assert.equal(step.scheduledAt.toISOString(), MONDAY_OPENS.toISOString());
  assert.equal((await events(sequence.id, "step_sent")).length, 0);

  await withJob({ senders, now: () => new Date(MONDAY_OPENS.getTime() + 60_000) }, async (job) => {
    const res = await job.tick();
    assert.equal(res.body.data.sent, 1);
  });

  assert.equal(calls.length, 1);
  step = await stepNow(steps[0].id);
  assert.equal(step.status, "sent");
});

// ── 3. mock mode records a mock send and marks the step sent ─────────

test("mock mode (default): email and SMS steps are marked sent as mock sends, nothing leaves the server", async () => {
  const { sequence, steps } = await seedApproved([
    { stepType: "EMAIL", scheduledAt: DUE_AT },
    { stepType: "SMS", scheduledAt: new Date(DUE_AT.getTime() + 60_000) },
  ]);

  // No fake senders: the real email and SMS services, which in mock mode
  // return before reading any mailbox or provider key.
  await withJob({ now: () => FRIDAY_INSIDE }, async (job) => {
    const res = await job.tick();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.mock, 2);
    assert.equal(res.body.data.sent, 0);
  });

  for (const made of steps) {
    const step = await stepNow(made.id);
    assert.equal(step.status, "sent");
    assert.equal(step.deliveryMode, "mock");
    assert.ok(step.sentAt);
    assert.match(step.sendLog ?? "", /^MOCK: /);
  }
  const sent = await events(sequence.id, "step_sent");
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((e) => (e.meta as { deliveryMode: string }).deliveryMode),
    ["mock", "mock"]
  );
});

// ── 4. a provider error marks the step failed and logs it ────────────

test("a provider error marks the step failed, records a failed event and is logged", async () => {
  const { sequence, steps } = await seedApproved([{ stepType: "EMAIL", scheduledAt: DUE_AT }]);
  const { senders } = spySenders();
  senders.sendEmail = async () => {
    throw new Error("SMTP 535 authentication failed");
  };

  const { lines } = await captureErrors(() =>
    withJob({ senders, now: () => FRIDAY_INSIDE }, async (job) => {
      const res = await job.tick();
      assert.equal(res.status, 200);
      assert.equal(res.body.data.failed, 1);
    })
  );

  const step = await stepNow(steps[0].id);
  assert.equal(step.status, "failed");
  assert.equal(step.sendLog, "Failed: SMTP 535 authentication failed");
  const failed = await events(sequence.id, "step_failed");
  assert.equal(failed.length, 1);
  assert.ok(
    lines.some((line) => line.includes(steps[0].id) && line.includes("SMTP 535")),
    "the failure is written to the error log with the step id"
  );
});

// ── never twice, never silent ────────────────────────────────────────

test("passes that overlap send each step once and move a waiting step only once", async () => {
  // inside the window: five passes at once, one provider call
  const sending = await seedApproved([{ stepType: "EMAIL", scheduledAt: DUE_AT }]);
  const fast = spySenders({ delayMs: 50 });
  await Promise.all(
    Array.from({ length: 5 }, () => runSendTick({ senders: fast.senders, now: FRIDAY_INSIDE }))
  );
  assert.equal(fast.calls.length, 1);
  assert.equal((await events(sending.sequence.id, "step_sent")).length, 1);

  // outside the window: the later step keeps its spacing, not shifted twice
  const waiting = await seedApproved([
    { stepType: "EMAIL", scheduledAt: DUE_AT },
    { stepType: "SMS", scheduledAt: new Date(DUE_AT.getTime() + 2 * 86_400_000) },
  ]);
  const spy = spySenders();
  await Promise.all(
    Array.from({ length: 5 }, () => runSendTick({ senders: spy.senders, now: FRIDAY_AFTER }))
  );
  const first = await stepNow(waiting.steps[0].id);
  const second = await stepNow(waiting.steps[1].id);
  assert.equal(first.scheduledAt.toISOString(), MONDAY_OPENS.toISOString());
  assert.equal(
    second.scheduledAt.getTime() - first.scheduledAt.getTime(),
    2 * 86_400_000,
    "the second step is still two days after the first"
  );
  assert.equal(spy.calls.length, 0);
});

test("an error in the send job answers 500 and is logged, never silent", async () => {
  const { lines, result } = await captureErrors(() =>
    withJob({ now: () => new Date(Number.NaN) }, (job) => job.tick())
  );
  assert.equal(result.status, 500);
  assert.equal(result.body.success, false);
  assert.ok(lines.some((line) => line.includes("[SendJob]")), "the error is in the log");
});

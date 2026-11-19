// S4 claim-before-send, S3b mock mode in the processor, and the checks made
// just before sending: do-not-contact, approval record, send window.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  spySenders,
  withEnv,
} from "./helpers/setup";
import {
  runSendTick,
  STALE_SENDING_MINUTES,
} from "../src/shared/services/send-processor";
import { currentApprovalHash } from "../src/harness/approval";
import { isInsideSendWindow, resolveSendWindow } from "../src/harness/send-window";

beforeEach(resetDb);
after(() => prisma.$disconnect());

const seed = async (
  stepOverrides: Record<string, unknown> = {},
  sequenceOverrides: Record<string, unknown> = {},
  leadOverrides: Record<string, unknown> = {}
) => {
  const user = await makeUser();
  const lead = await makeLead(user.id, leadOverrides);
  const sequence = await makeSequence(user.id, lead.id, sequenceOverrides);
  const step = await makeStep(sequence.id, stepOverrides);
  return { user, lead, sequence, step };
};

const stepNow = (id: string) => prisma.sequenceStep.findUniqueOrThrow({ where: { id } });
const sequenceNow = (id: string) => prisma.sequence.findUniqueOrThrow({ where: { id } });

/** Records a person's approval of the sequence exactly as it is now. */
const approve = async (sequenceId: string, userId: string) =>
  prisma.sequence.update({
    where: { id: sequenceId },
    data: {
      approvalStatus: "approved",
      approvedAt: new Date(),
      approvedByUserId: userId,
      approvedContentHash: await currentApprovalHash(sequenceId),
    },
  });

const setTimezone = (userId: string, sendTimezone: string | null) =>
  prisma.userSettings.upsert({
    where: { userId },
    create: { userId, sendTimezone },
    update: { sendTimezone },
  });

// Wednesday 18 Nov 2026, 10:00 in London: inside the default window.
const WEDNESDAY_10 = new Date("2026-11-18T10:00:00Z");
// Saturday 21 Nov 2026, 12:00 in London: outside (weekend).
const SATURDAY_NOON = new Date("2026-11-21T12:00:00Z");
// Wednesday 18 Nov 2026, 23:00 in London: outside (night).
const WEDNESDAY_23 = new Date("2026-11-18T23:00:00Z");

// ── claim before send ────────────────────────────────────────────────

test("a due step is claimed, sent once and recorded", async () => {
  const { step, sequence, lead } = await seed();
  const { senders, calls } = spySenders();

  await runSendTick({ senders });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, lead.email);

  const after = await stepNow(step.id);
  assert.equal(after.status, "sent");
  assert.ok(after.sentAt);
  assert.ok(after.sendingStartedAt, "the claim time is recorded");
  assert.equal(after.deliveryMode, "live");
  assert.equal((await sequenceNow(sequence.id)).status, "completed");
});

test("two processors at the same moment: the provider is called once", async () => {
  const { step } = await seed();
  const { senders, calls } = spySenders({ delayMs: 200 });

  await Promise.all([runSendTick({ senders }), runSendTick({ senders })]);

  assert.equal(calls.length, 1, "the same step must never be sent twice");
  assert.equal((await stepNow(step.id)).status, "sent");
});

test("five processors and three due steps: each step is sent exactly once", async () => {
  const user = await makeUser();
  const stepIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const lead = await makeLead(user.id);
    const sequence = await makeSequence(user.id, lead.id);
    stepIds.push((await makeStep(sequence.id, { content: `message ${i}` })).id);
  }
  const { senders, calls } = spySenders({ delayMs: 100 });

  await Promise.all(Array.from({ length: 5 }, () => runSendTick({ senders })));

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.text).sort(),
    ["message 0", "message 1", "message 2"]
  );
  for (const id of stepIds) assert.equal((await stepNow(id)).status, "sent");
});

test("a step that is not due, or whose sequence is paused, is not sent", async () => {
  const future = await seed({ scheduledAt: new Date(Date.now() + 3_600_000) });
  const paused = await seed({}, { status: "paused" });
  const { senders, calls } = spySenders();

  await runSendTick({ senders });

  assert.equal(calls.length, 0);
  assert.equal((await stepNow(future.step.id)).status, "scheduled");
  assert.equal((await stepNow(paused.step.id)).status, "scheduled");
});

test("a provider error marks the step failed and is not retried", async () => {
  const { step } = await seed();
  const { senders, calls } = spySenders();
  senders.sendEmail = async () => {
    calls.push({ channel: "EMAIL", to: "x", text: "x" });
    throw new Error("SMTP refused");
  };

  await runSendTick({ senders });
  await runSendTick({ senders });

  assert.equal(calls.length, 1);
  const after = await stepNow(step.id);
  assert.equal(after.status, "failed");
  assert.match(after.sendLog ?? "", /SMTP refused/);
});

// ── interrupted sends ────────────────────────────────────────────────

test(`stuck in "sending" for more than ${STALE_SENDING_MINUTES} minutes: failed as interrupted, never sent again`, async () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const stuck = await seed({ status: "sending", sendingStartedAt: minutesAgo(16) });
  const stuckSms = await seed({
    stepType: "SMS",
    status: "sending",
    sendingStartedAt: minutesAgo(120),
  });
  const recent = await seed({ status: "sending", sendingStartedAt: minutesAgo(14) });
  const whatsappWaiting = await seed({
    stepType: "WHATSAPP",
    status: "sending",
    sendingStartedAt: minutesAgo(60),
    externalMessageId: `SM-${randomUUID()}`,
  });
  const oldStyleRow = await seed({ status: "sending", sendingStartedAt: null });
  const { senders, calls } = spySenders();

  await runSendTick({ senders });
  await runSendTick({ senders });

  assert.equal(calls.length, 0, "an interrupted step is never sent again");

  for (const id of [stuck.step.id, stuckSms.step.id]) {
    const after = await stepNow(id);
    assert.equal(after.status, "failed");
    assert.match(after.sendLog ?? "", /interrupted/i);
    assert.equal(after.sentAt, null);
  }

  assert.equal((await stepNow(recent.step.id)).status, "sending");
  assert.equal(
    (await stepNow(whatsappWaiting.step.id)).status,
    "sending",
    "a WhatsApp step waiting for its delivery report is left alone"
  );
  assert.equal((await stepNow(oldStyleRow.step.id)).status, "sending");
});

// ── mock mode in the processor ───────────────────────────────────────

test("mock mode (the default): all four channels are recorded as mock sends", async () => {
  const email = await seed({ stepType: "EMAIL" });
  const sms = await seed({ stepType: "SMS" });
  const whatsapp = await seed({ stepType: "WHATSAPP" });
  const call = await seed({ stepType: "CALL" });

  // The real adapters, with OUTBOUND_MODE not set.
  await withEnv({ OUTBOUND_MODE: undefined }, () => runSendTick());

  for (const { step } of [email, sms, whatsapp, call]) {
    const after = await stepNow(step.id);
    assert.equal(after.status, "sent", after.stepType);
    assert.equal(after.deliveryMode, "mock", after.stepType);
    assert.match(after.sendLog ?? "", /^MOCK:/, after.stepType);
  }
});

// ── do-not-contact, just before sending ──────────────────────────────

test("do-not-contact lead: nothing is sent on any of the four channels", async () => {
  for (const stepType of ["EMAIL", "SMS", "WHATSAPP", "CALL"]) {
    await resetDb();
    const { step, sequence } = await seed({ stepType }, {}, { doNotContact: true });
    const { senders, calls } = spySenders();

    await runSendTick({ senders });

    assert.equal(calls.length, 0, stepType);
    const after = await stepNow(step.id);
    assert.equal(after.status, "scheduled", stepType);
    assert.match(after.sendLog ?? "", /do-not-contact/);
    const seq = await sequenceNow(sequence.id);
    assert.equal(seq.status, "paused");
    assert.equal(seq.pausedReason, "do_not_contact");
  }
});

test("a blocked address stops the send even when the lead's own flag is not set", async () => {
  const { user, lead, step, sequence } = await seed({}, {}, { email: "Blocked.Person@Example.com" });
  await prisma.suppressedContact.create({
    data: { userId: user.id, kind: "email", value: "blocked.person@example.com", source: "user" },
  });
  assert.equal(lead.doNotContact, false);
  const { senders, calls } = spySenders();

  await runSendTick({ senders });

  assert.equal(calls.length, 0);
  assert.equal((await stepNow(step.id)).status, "scheduled");
  assert.equal((await sequenceNow(sequence.id)).pausedReason, "do_not_contact");
});

// ── approval record (sequences made through the harness) ─────────────

test("harness sequence without a person's approval is not sent, and is paused", async () => {
  const { user, step, sequence } = await seed({ scheduledAt: new Date(WEDNESDAY_10.getTime() - 60_000) }, { runId: randomUUID() });
  await setTimezone(user.id, "Europe/London");
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_10 });

  assert.equal(calls.length, 0);
  const after = await stepNow(step.id);
  assert.equal(after.status, "scheduled", "the claim is released");
  assert.equal(after.sendingStartedAt, null);
  const seq = await sequenceNow(sequence.id);
  assert.equal(seq.status, "paused");
  assert.equal(seq.pausedReason, "not_approved");
});

test("harness sequence approved and unchanged is sent", async () => {
  const { user, step, sequence } = await seed({ scheduledAt: new Date(WEDNESDAY_10.getTime() - 60_000) }, { runId: randomUUID() });
  await setTimezone(user.id, "Europe/London");
  await approve(sequence.id, user.id);
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_10 });

  assert.equal(calls.length, 1);
  assert.equal((await stepNow(step.id)).status, "sent");
});

test("harness sequence edited after approval is not sent", async () => {
  const { user, step, sequence } = await seed({ scheduledAt: new Date(WEDNESDAY_10.getTime() - 60_000) }, { runId: randomUUID() });
  await setTimezone(user.id, "Europe/London");
  await approve(sequence.id, user.id);
  await prisma.sequenceStep.update({
    where: { id: step.id },
    data: { content: "Changed after the person approved it." },
  });
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_10 });

  assert.equal(calls.length, 0);
  assert.equal((await stepNow(step.id)).status, "scheduled");
  const seq = await sequenceNow(sequence.id);
  assert.equal(seq.status, "paused");
  assert.equal(seq.pausedReason, "changed_after_approval");
});

test("harness sequence whose recipient changed after approval is not sent", async () => {
  const { user, lead, step, sequence } = await seed({ scheduledAt: new Date(WEDNESDAY_10.getTime() - 60_000) }, { runId: randomUUID() });
  await setTimezone(user.id, "Europe/London");
  await approve(sequence.id, user.id);
  await prisma.lead.update({
    where: { id: lead.id },
    data: { email: "someone-else@example.com" },
  });
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_10 });

  assert.equal(calls.length, 0);
  assert.equal((await stepNow(step.id)).status, "scheduled");
  assert.equal((await sequenceNow(sequence.id)).pausedReason, "changed_after_approval");
});

test("a sequence made in the app's wizard keeps today's behaviour: no approval record needed", async () => {
  const { step } = await seed({}, { runId: null });
  const { senders, calls } = spySenders();

  await runSendTick({ senders });

  assert.equal(calls.length, 1);
  assert.equal((await stepNow(step.id)).status, "sent");
});

// ── send window, just before sending ─────────────────────────────────

test("harness step due on a Saturday waits for Monday 09:00, and later steps keep their spacing", async () => {
  const user = await makeUser();
  const lead = await makeLead(user.id);
  const sequence = await makeSequence(user.id, lead.id, { runId: randomUUID(), totalSteps: 2 });
  const due = new Date(SATURDAY_NOON.getTime() - 3_600_000);
  const first = await makeStep(sequence.id, { stepOrder: 1, scheduledAt: due });
  const second = await makeStep(sequence.id, {
    stepOrder: 2,
    scheduledAt: new Date(due.getTime() + 2 * 86_400_000),
  });
  await setTimezone(user.id, "Europe/London");
  await approve(sequence.id, user.id);
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: SATURDAY_NOON });

  assert.equal(calls.length, 0, "nothing goes out at the weekend");
  const firstAfter = await stepNow(first.id);
  assert.equal(firstAfter.status, "scheduled");
  assert.equal(firstAfter.scheduledAt.toISOString(), "2026-11-23T09:00:00.000Z");
  const secondAfter = await stepNow(second.id);
  assert.equal(
    secondAfter.scheduledAt.getTime() - firstAfter.scheduledAt.getTime(),
    2 * 86_400_000,
    "the two-day gap is kept"
  );
  assert.equal((await sequenceNow(sequence.id)).status, "active");

  // On Monday morning it goes out.
  await runSendTick({ senders, now: new Date("2026-11-23T09:00:30Z") });
  assert.equal(calls.length, 1);
  assert.equal((await stepNow(first.id)).status, "sent");
});

test("harness step due at night waits for the next morning", async () => {
  const { user, step, sequence } = await seed(
    { scheduledAt: new Date(WEDNESDAY_23.getTime() - 60_000) },
    { runId: randomUUID() }
  );
  await setTimezone(user.id, "Europe/London");
  await approve(sequence.id, user.id);
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_23 });

  assert.equal(calls.length, 0);
  const after = await stepNow(step.id);
  assert.equal(after.status, "scheduled");
  assert.equal(after.scheduledAt.toISOString(), "2026-11-19T09:00:00.000Z");

  const window = resolveSendWindow({
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    sendOnWeekends: false,
    sendTimezone: "Europe/London",
  });
  assert.ok(window.ok && isInsideSendWindow(after.scheduledAt, window.window));
});

test("harness step with no timezone set does not go out; it waits (no UTC fallback)", async () => {
  const { user, step, sequence } = await seed(
    { scheduledAt: new Date(WEDNESDAY_10.getTime() - 60_000) },
    { runId: randomUUID() }
  );
  await approve(sequence.id, user.id);
  // 10:00 UTC on a Wednesday would be "inside" a UTC window. It must still wait.
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_10 });

  assert.equal(calls.length, 0);
  const after = await stepNow(step.id);
  assert.equal(after.status, "scheduled");
  assert.match(after.sendLog ?? "", /timezone/i);
  assert.ok(after.scheduledAt.getTime() > WEDNESDAY_10.getTime());
  assert.equal((await sequenceNow(sequence.id)).status, "active");
});

test("a wizard sequence is not held back by the send window (today's behaviour)", async () => {
  const { step } = await seed({ scheduledAt: new Date(WEDNESDAY_23.getTime() - 60_000) });
  const { senders, calls } = spySenders();

  await runSendTick({ senders, now: WEDNESDAY_23 });

  assert.equal(calls.length, 1);
  assert.equal((await stepNow(step.id)).status, "sent");
});

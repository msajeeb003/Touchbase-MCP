// S2 (limited): the call and WhatsApp webhooks may only touch their own step type,
// and one switch turns both off.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  startApp,
  withEnv,
} from "./helpers/setup";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

const postRetell = (call: Record<string, unknown>) =>
  fetch(`${app.url}/webhooks/retell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "call_ended", call }),
  });

const postTwilio = (fields: Record<string, string>) =>
  fetch(`${app.url}/webhooks/twilio/whatsapp-status`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const seed = async (stepOverrides: Record<string, unknown>) => {
  const user = await makeUser();
  const lead = await makeLead(user.id);
  const sequence = await makeSequence(user.id, lead.id);
  const step = await makeStep(sequence.id, stepOverrides);
  return { user, sequence, step };
};

const stepNow = (id: string) => prisma.sequenceStep.findUniqueOrThrow({ where: { id } });

test("Retell webhook naming an EMAIL step changes nothing", async () => {
  const { user, sequence, step } = await seed({ stepType: "EMAIL", status: "scheduled" });

  const res = await postRetell({
    call_id: `call-${randomUUID()}`,
    call_status: "ended",
    disconnection_reason: "agent_hangup",
    metadata: { stepId: step.id, sequenceId: sequence.id, userId: user.id },
  });

  assert.equal(res.status, 200);
  const after = await stepNow(step.id);
  assert.equal(after.status, "scheduled");
  assert.equal(after.sentAt, null);
  assert.equal(after.sendLog, null);
  assert.equal(await prisma.callLog.count(), 0, "no call log is written for an email step");
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } })).status,
    "active"
  );
});

test("Retell webhook naming an SMS step, or failing an email step, changes nothing", async () => {
  const sms = await seed({ stepType: "SMS", status: "scheduled" });
  const email = await seed({ stepType: "EMAIL", status: "scheduled" });

  await postRetell({
    call_id: `call-${randomUUID()}`,
    call_status: "ended",
    disconnection_reason: "agent_hangup",
    metadata: { stepId: sms.step.id, sequenceId: sms.sequence.id, userId: sms.user.id },
  });
  await postRetell({
    call_id: `call-${randomUUID()}`,
    call_status: "error",
    disconnection_reason: "dial_failed",
    metadata: { stepId: email.step.id, sequenceId: email.sequence.id, userId: email.user.id },
  });

  assert.equal((await stepNow(sms.step.id)).status, "scheduled");
  assert.equal((await stepNow(email.step.id)).status, "scheduled");
  assert.equal(await prisma.callLog.count(), 0);
});

test("Retell webhook with another user's id on a call step changes nothing", async () => {
  const { sequence, step } = await seed({ stepType: "CALL", status: "calling" });
  const stranger = await makeUser();

  await postRetell({
    call_id: `call-${randomUUID()}`,
    call_status: "ended",
    disconnection_reason: "agent_hangup",
    metadata: { stepId: step.id, sequenceId: sequence.id, userId: stranger.id },
  });

  assert.equal((await stepNow(step.id)).status, "calling");
  assert.equal(await prisma.callLog.count(), 0);
});

test("Retell webhook still updates a CALL step as it does today", async () => {
  const { user, sequence, step } = await seed({ stepType: "CALL", status: "calling" });
  const callId = `call-${randomUUID()}`;

  const res = await postRetell({
    call_id: callId,
    call_status: "ended",
    disconnection_reason: "agent_hangup",
    start_timestamp: 1_000_000,
    end_timestamp: 1_042_000,
    metadata: { stepId: step.id, sequenceId: sequence.id, userId: user.id },
  });

  assert.equal(res.status, 200);
  const after = await stepNow(step.id);
  assert.equal(after.status, "sent");
  assert.ok(after.sentAt);
  const log = await prisma.callLog.findUniqueOrThrow({ where: { retellCallId: callId } });
  assert.equal(log.stepId, step.id);
  assert.equal(log.duration, 42);
});

test("Twilio WhatsApp webhook naming an EMAIL step changes nothing", async () => {
  const sid = `SM-${randomUUID()}`;
  const { step } = await seed({
    stepType: "EMAIL",
    status: "scheduled",
    externalMessageId: sid,
  });

  const delivered = await postTwilio({ MessageSid: sid, MessageStatus: "delivered" });
  assert.equal(delivered.status, 200);
  assert.equal((await stepNow(step.id)).status, "scheduled");

  await postTwilio({ MessageSid: sid, MessageStatus: "failed", ErrorCode: "30008" });
  const after = await stepNow(step.id);
  assert.equal(after.status, "scheduled");
  assert.equal(after.sendLog, null);
});

test("Twilio WhatsApp webhook still updates a WHATSAPP step as it does today", async () => {
  const sid = `SM-${randomUUID()}`;
  const { step } = await seed({
    stepType: "WHATSAPP",
    status: "sending",
    externalMessageId: sid,
  });

  const res = await postTwilio({ MessageSid: sid, MessageStatus: "delivered" });

  assert.equal(res.status, 200);
  const after = await stepNow(step.id);
  assert.equal(after.status, "sent");
  assert.ok(after.sentAt);
});

test("with ENABLE_PROVIDER_WEBHOOKS=false both routes answer 404 and change nothing", async () => {
  const call = await seed({ stepType: "CALL", status: "calling" });
  const sid = `SM-${randomUUID()}`;
  const whatsapp = await seed({
    stepType: "WHATSAPP",
    status: "sending",
    externalMessageId: sid,
  });

  await withEnv({ ENABLE_PROVIDER_WEBHOOKS: "false" }, async () => {
    const retell = await postRetell({
      call_id: `call-${randomUUID()}`,
      call_status: "ended",
      disconnection_reason: "agent_hangup",
      metadata: {
        stepId: call.step.id,
        sequenceId: call.sequence.id,
        userId: call.user.id,
      },
    });
    assert.equal(retell.status, 404);

    const twilio = await postTwilio({ MessageSid: sid, MessageStatus: "delivered" });
    assert.equal(twilio.status, 404);
  });

  assert.equal((await stepNow(call.step.id)).status, "calling");
  assert.equal((await stepNow(whatsapp.step.id)).status, "sending");

  // Switched back on (the default), the routes answer again.
  const again = await postTwilio({ MessageSid: sid, MessageStatus: "delivered" });
  assert.equal(again.status, 200);
  assert.equal((await stepNow(whatsapp.step.id)).status, "sent");
});

// The REST endpoints the Touchbase app uses to show what Claude did.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  apiClient,
  makeAccessToken,
  makeLead,
  makeRun,
  makeSequence,
  makeUser,
  prisma,
  resetDb,
  startApp,
  tokenFor,
} from "./helpers/setup";
import { recordRunEvent } from "../src/harness/runs/run.service";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

const DAY = 86_400_000;

const makeStep = (sequenceId: string, stepOrder: number, data: Record<string, unknown>) =>
  prisma.sequenceStep.create({
    data: {
      sequenceId,
      stepOrder,
      stepType: "EMAIL",
      subject: `Subject ${stepOrder}`,
      content: `Body ${stepOrder}`,
      status: "draft",
      scheduledAt: new Date(Date.now() + stepOrder * DAY),
      ...data,
    },
  });

/** One run with three sequences in different states, the way Phase 4 will leave them. */
const seedRun = async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const run = await makeRun(user.id, { instruction: "Follow up with the trade show leads" });

  await recordRunEvent(prisma, { runId: run.id, toolName: "start_run", summary: "Run started", ok: true });
  await recordRunEvent(prisma, {
    runId: run.id,
    toolName: "search_leads",
    summary: "Found 3 leads",
    ok: true,
    touched: [{ type: "lead", id: "lead-1", label: "Dana" }],
  });
  await recordRunEvent(prisma, {
    runId: run.id,
    toolName: "write_steps",
    summary: "Failed: This lead is marked do-not-contact.",
    ok: false,
    errorCode: "DO_NOT_CONTACT",
  });

  // 1. a draft awaiting approval, written from a call transcript
  const dana = await makeLead(user.id, { name: "Dana Whitfield", company: "Whitfield Dental" });
  const transcript = await prisma.leadTranscript.create({
    data: {
      userId: user.id,
      leadId: dana.id,
      source: "manual",
      meetingTitle: "Demo call",
      meetingDate: new Date("2026-10-12T10:00:00Z"),
      transcript: "Synthetic transcript.",
    },
  });
  const awaiting = await makeSequence(user.id, dana.id, {
    runId: run.id,
    name: "Dana follow-up",
    status: "draft",
    approvalStatus: "awaiting_approval",
    totalSteps: 2,
  });
  await makeStep(awaiting.id, 1, {
    delayMinutes: 0,
    basis: "transcript",
    basedOnTranscriptIds: [transcript.id],
    basedOnNote: "She asked for a one-page summary for the practice owners.",
  });
  await makeStep(awaiting.id, 2, { stepType: "SMS", subject: null, delayMinutes: 2880, basis: "transcript", basedOnTranscriptIds: [transcript.id] });

  // 2. a draft written without a transcript; one was saved afterwards
  const omar = await makeLead(user.id, { name: "Omar Haddad", company: null });
  const noTranscript = await makeSequence(user.id, omar.id, {
    runId: run.id,
    name: "Omar follow-up",
    status: "draft",
  });
  await makeStep(noTranscript.id, 1, { delayMinutes: 1440, basis: "notes_and_stage" });
  await prisma.leadTranscript.create({
    data: {
      userId: user.id,
      leadId: omar.id,
      source: "manual",
      meetingTitle: "Late call",
      meetingDate: new Date(),
      transcript: "Synthetic transcript.",
    },
  });

  // 3. an approved, running sequence with one message sent and one failed
  const priya = await makeLead(user.id, { name: "Priya Nair" });
  const active = await makeSequence(user.id, priya.id, {
    runId: run.id,
    name: "Priya follow-up",
    status: "active",
    approvalStatus: "approved",
    approvedAt: new Date(),
    totalSteps: 3,
  });
  const sentAt = new Date(Date.now() - DAY);
  await makeStep(active.id, 1, { status: "sent", sentAt, scheduledAt: sentAt, deliveryMode: "mock", sendLog: "MOCK: email" });
  await makeStep(active.id, 2, { status: "failed", scheduledAt: sentAt, sendLog: "Failed: SMTP refused" });
  await makeStep(active.id, 3, { status: "scheduled", scheduledAt: new Date(Date.now() + DAY) });

  return { user, api, run, transcript, awaiting, noTranscript, active };
};

test("GET /runs lists the user's runs, newest first, with counts", async () => {
  const { user, api, run } = await seedRun();
  const older = await makeRun(user.id, {
    instruction: "An older instruction",
    createdAt: new Date(Date.now() - 2 * 3_600_000),
    status: "completed",
    finishedAt: new Date(Date.now() - 3_600_000),
    summary: "All done.",
  });
  const stranger = await makeUser();
  await makeRun(stranger.id, { instruction: "Not yours" });

  const res = await api("GET", "/runs");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items.map((r: any) => r.run_id), [run.id, older.id]);
  assert.equal(res.body.data.pagination.total, 2);

  const first = res.body.data.items[0];
  assert.equal(first.instruction, "Follow up with the trade show leads");
  assert.equal(first.status, "in_progress");
  assert.deepEqual(first.counts, {
    sequences: 3,
    awaiting_approval: 1,
    active: 1,
    paused: 0,
    steps_sent: 1,
    steps_failed: 1,
    drafts_with_no_call_transcript: 1,
  });
  assert.equal(res.body.data.items[1].counts.sequences, 0);
  assert.equal(JSON.stringify(res.body).includes("Not yours"), false);
});

test("GET /runs can be filtered by status and paged; a wrong status is refused", async () => {
  const { user, api } = await seedRun();
  for (let i = 0; i < 3; i++) {
    await makeRun(user.id, { status: "completed", finishedAt: new Date(), createdAt: new Date(Date.now() - (i + 1) * 60_000) });
  }

  const completed = await api("GET", "/runs?status=completed&limit=2&page=1");
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.items.length, 2);
  assert.equal(completed.body.data.pagination.total, 3);
  assert.equal(completed.body.data.pagination.total_pages, 2);
  assert.ok(completed.body.data.items.every((r: any) => r.status === "completed"));

  const page2 = await api("GET", "/runs?status=completed&limit=2&page=2");
  assert.equal(page2.body.data.items.length, 1);

  const bad = await api("GET", "/runs?status=sent");
  assert.equal(bad.status, 400);
});

test("GET /runs/:id returns the run, its events in order, and its sequences with steps", async () => {
  const { api, run, transcript, awaiting, noTranscript, active } = await seedRun();

  const res = await api("GET", `/runs/${run.id}`);

  assert.equal(res.status, 200);
  const { run: runOut, events, sequences } = res.body.data;
  assert.equal(runOut.run_id, run.id);
  assert.equal(runOut.counts.sequences, 3);

  assert.deepEqual(
    events.events.map((e: any) => [e.seq, e.tool, e.ok, e.error_code]),
    [
      [1, "start_run", true, null],
      [2, "search_leads", true, null],
      [3, "write_steps", false, "DO_NOT_CONTACT"],
    ]
  );
  assert.deepEqual(events.events[1].touched, [{ type: "lead", id: "lead-1", label: "Dana" }]);
  assert.equal(events.last_seq, 3);
  assert.equal(events.has_more, false);

  const byId = Object.fromEntries(sequences.items.map((s: any) => [s.sequence_id, s]));

  // 1. awaiting approval, based on a transcript
  const one = byId[awaiting.id];
  assert.equal(one.name, "Dana follow-up");
  assert.equal(one.status, "draft");
  assert.equal(one.approval_status, "awaiting_approval");
  assert.equal(one.no_call_transcript, false);
  assert.deepEqual(one.lead.untrusted, { name: "Dana Whitfield", company: "Whitfield Dental" });
  assert.equal(one.lead.do_not_contact, false);
  assert.deepEqual(
    { ...one.steps[0], step_id: undefined },
    {
      step_id: undefined,
      step_number: 1,
      channel: "email",
      status: "draft",
      delay_days: 0,
      scheduled_for: null,
      sent_at: null,
      delivery_mode: null,
      subject: "Subject 1",
      body: "Body 1",
      send_log: null,
      based_on: {
        kind: "transcript",
        transcripts: [
          { id: transcript.id, meeting_date: "2026-10-12", untrusted_meeting_title: "Demo call" },
        ],
        note: "She asked for a one-page summary for the practice owners.",
      },
    }
  );
  assert.equal(one.steps[1].channel, "sms");
  assert.equal(one.steps[1].delay_days, 2);

  // 2. no call transcript at the time of writing; one was added since
  const two = byId[noTranscript.id];
  assert.equal(two.no_call_transcript, true);
  assert.equal(two.transcript_added_since, true);
  assert.equal(two.steps[0].based_on.kind, "notes_and_stage");
  assert.deepEqual(two.steps[0].based_on.transcripts, []);

  // 3. live status of a running sequence
  const three = byId[active.id];
  assert.equal(three.status, "active");
  assert.ok(three.approved_at);
  assert.deepEqual(three.steps.map((s: any) => s.status), ["sent", "failed", "scheduled"]);
  assert.ok(three.steps[0].sent_at);
  assert.equal(three.steps[0].delivery_mode, "mock");
  assert.ok(three.steps[2].scheduled_for, "an approved step has a real date");
  assert.equal(three.steps[0].based_on.kind, "not_stated");
});

test("the status in the run endpoints is live: a change shows up on the next read", async () => {
  const { api, run, active } = await seedRun();

  await prisma.sequenceStep.updateMany({
    where: { sequenceId: active.id, status: "scheduled" },
    data: { status: "sent", sentAt: new Date() },
  });
  await prisma.sequence.update({
    where: { id: active.id },
    data: { status: "paused", pausedReason: "lead_replied", pausedAt: new Date() },
  });

  const list = await api("GET", "/runs");
  assert.equal(list.body.data.items[0].counts.steps_sent, 2);
  assert.equal(list.body.data.items[0].counts.active, 0);
  assert.equal(list.body.data.items[0].counts.paused, 1);

  const sequences = await api("GET", `/runs/${run.id}/sequences`);
  const paused = sequences.body.data.items.find((s: any) => s.sequence_id === active.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.paused_reason, "lead_replied");
});

test("GET /runs/:id/events?after= returns only newer events", async () => {
  const { api, run } = await seedRun();

  const newer = await api("GET", `/runs/${run.id}/events?after=2`);
  assert.equal(newer.status, 200);
  assert.deepEqual(newer.body.data.events.map((e: any) => e.seq), [3]);
  assert.equal(newer.body.data.last_seq, 3);

  const none = await api("GET", `/runs/${run.id}/events?after=3`);
  assert.deepEqual(none.body.data.events, []);
  assert.equal(none.body.data.last_seq, 3);

  const paged = await api("GET", `/runs/${run.id}/events?limit=2`);
  assert.deepEqual(paged.body.data.events.map((e: any) => e.seq), [1, 2]);
  assert.equal(paged.body.data.has_more, true);
});

test("GET /runs/:id/sequences is paged", async () => {
  const { api, run } = await seedRun();

  const first = await api("GET", `/runs/${run.id}/sequences?limit=2`);
  assert.equal(first.body.data.items.length, 2);
  assert.equal(first.body.data.pagination.total, 3);
  const second = await api("GET", `/runs/${run.id}/sequences?limit=2&page=2`);
  assert.equal(second.body.data.items.length, 1);
});

test("another user's run answers 404, exactly like a run that does not exist", async () => {
  const { run } = await seedRun();
  const stranger = await makeUser();
  const asStranger = apiClient(app.url, tokenFor(stranger));

  for (const path of ["", "/events", "/sequences"]) {
    const theirs = await asStranger("GET", `/runs/${run.id}${path}`);
    const missing = await asStranger("GET", `/runs/${randomUUID()}${path}`);
    assert.equal(theirs.status, 404, path);
    assert.equal(theirs.body.message, "Run not found");
    assert.equal(missing.status, 404, path);
    assert.equal(missing.body.message, theirs.body.message);
  }
});

test("the run endpoints need a login session: no token and an access token are refused", async () => {
  const { user, run } = await seedRun();
  const { token } = await makeAccessToken(user.id);

  for (const path of ["/runs", `/runs/${run.id}`, `/runs/${run.id}/events`, `/runs/${run.id}/sequences`]) {
    assert.equal((await apiClient(app.url)("GET", path)).status, 401, `${path} without a token`);
    assert.equal((await apiClient(app.url, token)("GET", path)).status, 401, `${path} with an access token`);
  }
});

test("a run nobody touched for a day is listed as abandoned", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const old = await makeRun(user.id, { createdAt: new Date(Date.now() - 30 * 3_600_000) });
  const fresh = await makeRun(user.id);

  const res = await api("GET", "/runs");

  const byId = Object.fromEntries(res.body.data.items.map((r: any) => [r.run_id, r]));
  assert.equal(byId[old.id].status, "abandoned");
  assert.equal(byId[fresh.id].status, "in_progress");
});

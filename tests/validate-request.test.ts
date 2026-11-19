// S1 (mass assignment) on every update path, and S5 (missing ownership check).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  apiClient,
  makeLead,
  makeSequence,
  makeUser,
  prisma,
  resetDb,
  startApp,
  tokenFor,
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

const twoUsers = async () => {
  const alice = await makeUser();
  const bob = await makeUser();
  return {
    alice,
    bob,
    asAlice: apiClient(app.url, tokenFor(alice)),
    asBob: apiClient(app.url, tokenFor(bob)),
  };
};

const makeTemplate = (userId: string, followUpStage = "New") =>
  prisma.promptTemplate.create({
    data: {
      userId,
      name: "Template",
      followUpStage,
      promptText: "Write a short, friendly follow-up.",
    },
  });

// ── update path 1: sequences ─────────────────────────────────────────

test("PATCH /sequences/:id ignores fields that are not in its schema", async () => {
  const { alice, bob, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id);
  const sequence = await makeSequence(alice.id, lead.id, { status: "draft" });

  const res = await asAlice("PATCH", `/sequences/${sequence.id}`, {
    name: "Renamed",
    userId: bob.id,
    runId: "11111111-1111-4111-8111-111111111111",
    approvalStatus: "approved",
    approvedByUserId: bob.id,
    approvedContentHash: "forged",
    approvedAt: new Date().toISOString(),
    goal: "forged goal",
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  assert.equal(res.status, 200);
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.name, "Renamed");
  assert.equal(after.userId, alice.id);
  assert.equal(after.runId, null);
  assert.equal(after.approvalStatus, "none");
  assert.equal(after.approvedByUserId, null);
  assert.equal(after.approvedContentHash, null);
  assert.equal(after.approvedAt, null);
  assert.equal(after.goal, null);
  assert.equal(after.createdAt.getTime(), sequence.createdAt.getTime());
});

test("PATCH /sequences/:id cannot point a sequence at another user's lead or template", async () => {
  const { alice, bob, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id);
  const bobsLead = await makeLead(bob.id);
  const bobsTemplate = await makeTemplate(bob.id);
  const sequence = await makeSequence(alice.id, lead.id, { status: "draft" });

  const withLead = await asAlice("PATCH", `/sequences/${sequence.id}`, { leadId: bobsLead.id });
  assert.equal(withLead.status, 404);

  const withTemplate = await asAlice("PATCH", `/sequences/${sequence.id}`, {
    promptTemplateId: bobsTemplate.id,
  });
  assert.equal(withTemplate.status, 404);

  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.leadId, lead.id);
  assert.equal(after.promptTemplateId, null);
});

test("the app's Edit Sequence dialog still works: its four fields are saved", async () => {
  const { alice, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id);
  const otherLead = await makeLead(alice.id);
  const template = await makeTemplate(alice.id);
  const sequence = await makeSequence(alice.id, lead.id, { status: "draft", totalSteps: 3 });

  // Exactly the body UpdateSequenceDialog.tsx sends.
  const res = await asAlice("PATCH", `/sequences/${sequence.id}`, {
    leadId: otherLead.id,
    name: "Edited in the dialog",
    totalSteps: 5,
    promptTemplateId: template.id,
  });

  assert.equal(res.status, 200);
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.leadId, otherLead.id);
  assert.equal(after.name, "Edited in the dialog");
  assert.equal(after.totalSteps, 5);
  assert.equal(after.promptTemplateId, template.id);

  const tooMany = await asAlice("PATCH", `/sequences/${sequence.id}`, { totalSteps: 21 });
  assert.equal(tooMany.status, 400);
});

test("the app's status buttons still work: pausing with the extra fields the page sends", async () => {
  const { alice, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id);
  const sequence = await makeSequence(alice.id, lead.id, { status: "active" });

  // Exactly the body SequencesPage.tsx sends.
  const res = await asAlice("PATCH", `/sequences/${sequence.id}`, {
    leadId: sequence.leadId,
    name: sequence.name,
    totalSteps: sequence.totalSteps,
    promptTemplateId: null,
    status: "paused",
  });

  assert.equal(res.status, 200);
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.status, "paused");
  assert.equal(after.pausedReason, "paused_by_user");
  assert.ok(after.pausedAt);
});

// ── update path 2: prompt templates ──────────────────────────────────

test("PATCH /prompt-templates/:id ignores userId and other unknown fields", async () => {
  const { alice, bob, asAlice } = await twoUsers();
  const template = await makeTemplate(alice.id);

  const res = await asAlice("PATCH", `/prompt-templates/${template.id}`, {
    name: "Renamed template",
    userId: bob.id,
    createdAt: "2000-01-01T00:00:00.000Z",
  });

  assert.equal(res.status, 200);
  const after = await prisma.promptTemplate.findUniqueOrThrow({ where: { id: template.id } });
  assert.equal(after.name, "Renamed template");
  assert.equal(after.userId, alice.id);
  assert.equal(after.createdAt.getTime(), template.createdAt.getTime());
});

// ── update path 3: transcripts ───────────────────────────────────────

test("PATCH /leads/:leadId/transcripts/:id ignores userId and leadId", async () => {
  const { alice, bob, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id);
  const otherLead = await makeLead(alice.id);
  const transcript = await prisma.leadTranscript.create({
    data: {
      userId: alice.id,
      leadId: lead.id,
      source: "manual",
      meetingTitle: "Intro call",
      meetingDate: new Date("2026-10-12T10:00:00Z"),
      transcript: "Synthetic transcript.",
    },
  });

  const res = await asAlice("PATCH", `/leads/${lead.id}/transcripts/${transcript.id}`, {
    meetingTitle: "Renamed call",
    userId: bob.id,
    leadId: otherLead.id,
    fathomRecordingId: 12345,
  });

  assert.equal(res.status, 200);
  const after = await prisma.leadTranscript.findUniqueOrThrow({ where: { id: transcript.id } });
  assert.equal(after.meetingTitle, "Renamed call");
  assert.equal(after.userId, alice.id);
  assert.equal(after.leadId, lead.id);
  assert.equal(after.fathomRecordingId, null);
});

// ── update path 4: settings ──────────────────────────────────────────

test("PATCH /settings ignores userId and the Fathom webhook secret fields", async () => {
  const { alice, bob, asAlice } = await twoUsers();

  const res = await asAlice("PATCH", "/settings", {
    smtpFromName: "Alice",
    userId: bob.id,
    id: "22222222-2222-4222-8222-222222222222",
    fathomWebhookId: "forged-id",
    fathomWebhookSecret: "forged-secret",
    senderName: "Forged",
  });

  assert.equal(res.status, 200);
  const mine = await prisma.userSettings.findUniqueOrThrow({ where: { userId: alice.id } });
  assert.equal(mine.smtpFromName, "Alice");
  assert.equal(mine.fathomWebhookId, null);
  assert.equal(mine.fathomWebhookSecret, null);
  assert.equal(mine.senderName, null);
  assert.notEqual(mine.id, "22222222-2222-4222-8222-222222222222");
  assert.equal(await prisma.userSettings.count({ where: { userId: bob.id } }), 0);
});

test("PATCH /settings saves a valid send window and refuses a bad one", async () => {
  const { alice, asAlice } = await twoUsers();

  const good = await asAlice("PATCH", "/settings", {
    sendWindowStart: "08:30",
    sendWindowEnd: "17:00",
    sendOnWeekends: true,
    sendTimezone: "Asia/Dhaka",
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.data.sendTimezone, "Asia/Dhaka");
  const saved = await prisma.userSettings.findUniqueOrThrow({ where: { userId: alice.id } });
  assert.equal(saved.sendWindowStart, "08:30");
  assert.equal(saved.sendWindowEnd, "17:00");
  assert.equal(saved.sendOnWeekends, true);

  for (const bad of [
    { sendWindowStart: "25:00" },
    { sendWindowStart: "9am" },
    { sendTimezone: "Mars/Olympus" },
    { sendTimezone: "" },
    { sendWindowStart: "18:00", sendWindowEnd: "09:00" },
    { sendWindowStart: "17:00" }, // the stored end is 17:00, so start must be earlier
  ]) {
    const res = await asAlice("PATCH", "/settings", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  const unchanged = await prisma.userSettings.findUniqueOrThrow({ where: { userId: alice.id } });
  assert.equal(unchanged.sendWindowStart, "08:30");
  assert.equal(unchanged.sendTimezone, "Asia/Dhaka");
});

// ── leads: the flag cannot be removed through an ordinary update ─────

test("PATCH /leads/:id cannot change the owner or remove do-not-contact", async () => {
  const { alice, bob, asAlice } = await twoUsers();
  const lead = await makeLead(alice.id, { doNotContact: true, doNotContactAt: new Date() });

  const res = await asAlice("PATCH", `/leads/${lead.id}`, {
    name: "Renamed lead",
    userId: bob.id,
    doNotContact: false,
    doNotContactAt: null,
  });

  assert.equal(res.status, 200);
  const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(after.name, "Renamed lead");
  assert.equal(after.userId, alice.id);
  assert.equal(after.doNotContact, true);
  assert.ok(after.doNotContactAt);
});

// ── S5: ownership ────────────────────────────────────────────────────

test("regenerate-all on another user's sequence answers 404, like a missing one", async () => {
  const { alice, asAlice, asBob } = await twoUsers();
  const lead = await makeLead(alice.id);
  const sequence = await makeSequence(alice.id, lead.id, { status: "draft" });

  const asOther = await asBob("POST", `/sequences/${sequence.id}/steps/regenerate-all`);
  assert.equal(asOther.status, 404);
  assert.equal(asOther.body.message, "Sequence not found");

  const missing = await asBob(
    "POST",
    "/sequences/33333333-3333-4333-8333-333333333333/steps/regenerate-all"
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, asOther.body.message);

  // The owner gets the normal answer for a sequence with no steps.
  const asOwner = await asAlice("POST", `/sequences/${sequence.id}/steps/regenerate-all`);
  assert.equal(asOwner.status, 400);
  assert.equal(asOwner.body.message, "No steps to regenerate");
});

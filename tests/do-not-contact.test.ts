// Rule 4: do-not-contact, by lead and by address. Human-only clear.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
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
  tokenFor,
} from "./helpers/setup";
import {
  isBlocked,
  markLeadDoNotContact,
  normalizeEmailAddress,
  normalizePhoneNumber,
} from "../src/harness/do-not-contact";
import { importLeadRows } from "../src/modules/lead/lead.service";
import { runSendTick } from "../src/shared/services/send-processor";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

const rowsFor = (userId: string) =>
  prisma.suppressedContact.findMany({ where: { userId }, orderBy: { kind: "asc" } });

test("addresses are compared in one normal form", () => {
  assert.equal(normalizeEmailAddress("  Sam.Lee@Example.COM "), "sam.lee@example.com");
  assert.equal(normalizeEmailAddress(""), null);
  assert.equal(normalizeEmailAddress(null), null);
  assert.equal(normalizeEmailAddress("not-an-email"), null);

  assert.equal(normalizePhoneNumber("+1 (555) 010-0001"), "+15550100001");
  assert.equal(normalizePhoneNumber("1 555 010 0001"), "+15550100001");
  assert.equal(normalizePhoneNumber("0015550100001"), "+15550100001");
  assert.equal(normalizePhoneNumber(""), null);
  assert.equal(normalizePhoneNumber("12"), null);
});

test("marking a lead writes a row per address, sets the flag and pauses its active sequence", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const lead = await makeLead(user.id, {
    email: "Sam.Lee@Example.com",
    phone: "+1 (555) 010-0001",
    status: "Active",
  });
  const sequence = await makeSequence(user.id, lead.id, { status: "active" });
  const draft = await makeSequence(user.id, lead.id, { status: "draft" });

  const res = await api("POST", `/leads/${lead.id}/do-not-contact`, {
    reason: "Asked us to stop",
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.pausedSequenceIds, [sequence.id]);
  assert.deepEqual(res.body.data.cancelledDraftIds, [draft.id]);

  const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(after.doNotContact, true);
  assert.equal(after.doNotContactReason, "Asked us to stop");
  assert.equal(after.doNotContactSource, "user");
  assert.ok(after.doNotContactAt);
  assert.equal(after.status, "Not Active");

  const rows = await rowsFor(user.id);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.value, r.source, r.leadId, r.clearedAt]),
    [
      ["email", "sam.lee@example.com", "user", lead.id, null],
      ["phone", "+15550100001", "user", lead.id, null],
    ]
  );

  const paused = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedReason, "do_not_contact");
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: draft.id } })).status,
    "cancelled",
    "an open draft can never be sent, so it is cancelled"
  );
});

test("marking twice changes nothing the second time", async () => {
  const user = await makeUser();
  const lead = await makeLead(user.id);

  const first = await markLeadDoNotContact({
    userId: user.id,
    leadId: lead.id,
    reason: "first",
    source: "mcp",
  });
  const rowsAfterFirst = await rowsFor(user.id);
  const second = await markLeadDoNotContact({
    userId: user.id,
    leadId: lead.id,
    reason: "second",
    source: "mcp",
  });
  const rowsAfterSecond = await rowsFor(user.id);

  assert.equal(first.alreadyMarked, false);
  assert.equal(second.alreadyMarked, true);
  assert.equal(rowsAfterSecond.length, 2);
  assert.deepEqual(rowsAfterSecond, rowsAfterFirst);
  assert.equal(second.lead.doNotContactReason, "first");
});

test("another user's lead cannot be marked or cleared: it answers 404", async () => {
  const owner = await makeUser();
  const stranger = await makeUser();
  const lead = await makeLead(owner.id);
  const asStranger = apiClient(app.url, tokenFor(stranger));

  const mark = await asStranger("POST", `/leads/${lead.id}/do-not-contact`, {});
  assert.equal(mark.status, 404);

  await markLeadDoNotContact({ userId: owner.id, leadId: lead.id, source: "user" });
  const clear = await asStranger("POST", `/leads/${lead.id}/do-not-contact/clear`, {
    reason: "let me in",
  });
  assert.equal(clear.status, 404);
  assert.equal(
    (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact,
    true
  );
});

test("a block belongs to one user: the same address is not blocked for another user", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const lead = await makeLead(user.id, { email: "shared@example.com" });
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "user" });

  assert.equal((await isBlocked(user.id, "SHARED@example.com", null)).blocked, true);
  assert.equal((await isBlocked(other.id, "shared@example.com", null)).blocked, false);
  assert.equal((await isBlocked(user.id, null, "+1 555 010 0001")).blocked, true);
  assert.equal((await isBlocked(user.id, "someone.else@example.com", "+15550109999")).blocked, false);
});

test("a new lead with a blocked email or phone is flagged at once", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const lead = await makeLead(user.id, { email: "stop@example.com", phone: "+15550100002" });
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "user" });
  await api("DELETE", `/leads/${lead.id}`);

  const byEmail = await api("POST", "/leads", { name: "Same email", email: "STOP@example.com" });
  assert.equal(byEmail.status, 201);
  assert.equal(byEmail.body.data.doNotContact, true);
  assert.equal(byEmail.body.data.doNotContactSource, "system");

  const byPhone = await api("POST", "/leads", { name: "Same phone", phone: "+1 555 010 0002" });
  assert.equal(byPhone.status, 201);
  assert.equal(byPhone.body.data.doNotContact, true);

  const clean = await api("POST", "/leads", { name: "Someone new", email: "new@example.com" });
  assert.equal(clean.body.data.doNotContact, false);
});

test("changing a lead's email to a blocked address flags that lead", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const blocked = await makeLead(user.id, { email: "stop@example.com" });
  await markLeadDoNotContact({ userId: user.id, leadId: blocked.id, source: "user" });
  await api("DELETE", `/leads/${blocked.id}`);
  const other = await makeLead(user.id, { email: "fine@example.com" });

  const res = await api("PATCH", `/leads/${other.id}`, { email: "stop@example.com" });

  assert.equal(res.status, 200);
  assert.equal(
    (await prisma.lead.findUniqueOrThrow({ where: { id: other.id } })).doNotContact,
    true
  );
});

test("deleted, then imported again: still blocked, not activated, not sent", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const original = await makeLead(user.id, { email: "gone@example.com", phone: null });
  await markLeadDoNotContact({
    userId: user.id,
    leadId: original.id,
    reason: "Unsubscribed",
    source: "mcp",
  });

  const deleted = await api("DELETE", `/leads/${original.id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await rowsFor(user.id)).length, 1, "the block outlives the lead");

  // The same address comes back in an import, with different capitals.
  const imported = await importLeadRows(user.id, [
    { name: "Gone Person", email: "Gone@Example.com" },
    { name: "Fresh Person", email: "fresh@example.com" },
  ]);
  assert.equal(imported.success, 2);

  const back = await prisma.lead.findFirstOrThrow({
    where: { userId: user.id, name: "Gone Person" },
  });
  const fresh = await prisma.lead.findFirstOrThrow({
    where: { userId: user.id, name: "Fresh Person" },
  });
  assert.equal(back.doNotContact, true);
  assert.equal(fresh.doNotContact, false);

  // Not activated: a person cannot start a sequence for the blocked lead.
  const sequence = await makeSequence(user.id, back.id, { status: "draft" });
  const step = await makeStep(sequence.id, {
    status: "draft",
    scheduledAt: new Date(Date.now() + 3_600_000),
  });
  const activate = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });
  assert.equal(activate.status, 400);
  assert.match(activate.body.message, /do-not-contact/);
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } })).status,
    "draft"
  );
  assert.equal(
    (await prisma.sequenceStep.findUniqueOrThrow({ where: { id: step.id } })).status,
    "draft"
  );

  // Not sent: even if the sequence were active and the step due.
  await prisma.sequence.update({ where: { id: sequence.id }, data: { status: "active" } });
  await prisma.sequenceStep.update({
    where: { id: step.id },
    data: { status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) },
  });
  const { senders, calls } = spySenders();
  await runSendTick({ senders });
  assert.equal(calls.length, 0);
  assert.equal(
    (await prisma.sequenceStep.findUniqueOrThrow({ where: { id: step.id } })).status,
    "scheduled"
  );
});

test("activation is refused when only the address is blocked (flag not set on the lead)", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const lead = await makeLead(user.id, { email: "quiet@example.com" });
  await prisma.suppressedContact.create({
    data: { userId: user.id, kind: "email", value: "quiet@example.com", source: "user" },
  });
  const sequence = await makeSequence(user.id, lead.id, { status: "draft" });
  await makeStep(sequence.id, {
    status: "draft",
    scheduledAt: new Date(Date.now() + 3_600_000),
  });

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /do-not-contact/);
});

test("clearing needs a login session: no token and a non-login token are refused", async () => {
  const user = await makeUser();
  const lead = await makeLead(user.id);
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "mcp" });
  const path = `/leads/${lead.id}/do-not-contact/clear`;

  const noToken = await apiClient(app.url)("POST", path, { reason: "please" });
  assert.equal(noToken.status, 401);

  // The shape an MCP access token will have. It is not a login token.
  const accessToken = await apiClient(app.url, "tb_pat_0123456789abcdef0123456789abcdef")(
    "POST",
    path,
    { reason: "please" }
  );
  assert.equal(accessToken.status, 401);

  const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(after.doNotContact, true);
  assert.equal((await isBlocked(user.id, lead.email, lead.phone)).blocked, true);
});

test("a logged-in person clears it with a reason, and the record says who, when and why", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const lead = await makeLead(user.id, { email: "back@example.com", phone: "+15550100003" });
  const sequence = await makeSequence(user.id, lead.id, { status: "active" });
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "mcp" });
  const path = `/leads/${lead.id}/do-not-contact/clear`;

  const noReason = await api("POST", path, {});
  assert.equal(noReason.status, 400);
  const blankReason = await api("POST", path, { reason: "   " });
  assert.equal(blankReason.status, 400);
  assert.equal(
    (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact,
    true
  );

  const before = Date.now();
  const res = await api("POST", path, { reason: "Marked by mistake" });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.clearedAddresses, 2);
  const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.equal(after.doNotContact, false);

  const rows = await rowsFor(user.id);
  assert.equal(rows.length, 2, "the rows are kept as a record");
  for (const row of rows) {
    assert.ok(row.clearedAt && row.clearedAt.getTime() >= before - 1000);
    assert.equal(row.clearedByUserId, user.id);
    assert.equal(row.clearReason, "Marked by mistake");
  }
  assert.equal((await isBlocked(user.id, lead.email, lead.phone)).blocked, false);

  // Clearing does not restart anything: the sequence stays paused.
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } })).status,
    "paused"
  );

  // Nothing left to clear.
  const again = await api("POST", path, { reason: "again" });
  assert.equal(again.status, 400);
});

test("an address cleared by a person can be blocked again", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const lead = await makeLead(user.id, { email: "again@example.com", phone: null });
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "user" });
  await api("POST", `/leads/${lead.id}/do-not-contact/clear`, { reason: "mistake" });

  await markLeadDoNotContact({
    userId: user.id,
    leadId: lead.id,
    reason: "Asked again",
    source: "mcp",
  });

  const rows = await rowsFor(user.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clearedAt, null);
  assert.equal(rows[0].source, "mcp");
  assert.equal((await isBlocked(user.id, "again@example.com", null)).blocked, true);
});

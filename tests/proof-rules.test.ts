// PHASE 5: proof of the safety rules, across ALL tools at once.
//
//   Rule 1  Claude prepares, a human releases   -> every tool called, nothing active, nothing sent
//   Rule 3  one user, ownership on every record -> user A's tools against user B's ids
//   Rule 4  do-not-contact                      -> not drafted, not approved, not activated, not sent, not cleared
//   Rule 5  limits                              -> each one at the limit and one above (see also proof-limits)
//   Rule 6  outsider text is labelled           -> a planted text never leaves `untrusted…`; answer shapes are fixed
//   Rule 7  safe to call twice                  -> every write tool called twice, the data compared
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  apiClient,
  makeAccessToken,
  makeRun,
  makeUser,
  outsideUntrusted,
  prisma,
  resetDb,
  spySenders,
  startApp,
  startSession,
} from "./helpers/setup";
import {
  buildWorld,
  callsFor,
  EXPECTED_ERRORS,
  MARKER,
  shapeOf,
  snapshotOf,
} from "./helpers/world";
import { resetRateLimits } from "../src/harness/rate-limit";
import { runSendTick } from "../src/shared/services/send-processor";
import { importLeadRows } from "../src/modules/lead/lead.service";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
  process.env.ENABLE_MCP = "true";
});
after(async () => {
  delete process.env.ENABLE_MCP;
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  resetRateLimits();
});

const SHAPES_FILE = path.join(__dirname, "snapshots", "tool-result-shapes.json");

const releasedCount = async (userId: string) => ({
  active: await prisma.sequence.count({ where: { userId, status: "active" } }),
  // a message that went out, or is on its way out
  outgoing: await prisma.sequenceStep.count({
    where: { sequence: { userId }, status: { in: ["sending", "calling", "sent"] } },
  }),
  // "scheduled" only counts as a danger while its sequence is running
  scheduledInRunning: await prisma.sequenceStep.count({
    where: { status: "scheduled", sequence: { userId, status: "active" } },
  }),
});

// ── rules 1 and 6, all 41 tools ──────────────────────────────────────

test("rules 1 and 6: all 41 tools are called with the switches off; nothing is released, and planted text stays labelled", async () => {
  const s = await startSession(app.mcpUrl);
  const world = await buildWorld(s.user.id, s.runId);
  const toolNames = (await s.client.listTools()).tools.map((tool) => tool.name).sort();
  const calls = callsFor(world, s.runId);

  assert.equal(toolNames.length, 41);
  assert.deepEqual(
    [...new Set(calls.map(([name]) => name))].sort(),
    toolNames,
    "this proof calls every tool the server offers"
  );

  const shapes: Record<string, unknown> = {};
  let sawMarker = 0;

  for (const [name, args] of calls) {
    const res = await s.call(name, args);

    if (EXPECTED_ERRORS[name]) {
      assert.equal(res.data?.error?.code, EXPECTED_ERRORS[name], name);
    } else {
      assert.equal(res.isError, false, `${name}: ${res.text.slice(0, 300)}`);
    }

    // Rule 6: the planted text may come back, but only inside an `untrusted…` field.
    if (res.text.includes(MARKER)) sawMarker++;
    assert.equal(
      outsideUntrusted(res.data).includes(MARKER),
      false,
      `${name} returned a lead's text outside an untrusted field`
    );
    // No secret, ever.
    assert.equal(res.text.includes("SECRET"), false, `${name} returned a settings secret`);
    assert.equal(res.text.includes(s.token), false, `${name} returned the access token`);
    // The text copy and the structured answer are the same answer.
    assert.deepEqual(JSON.parse(res.text), res.data, name);

    shapes[name] = shapeOf(res.data);
  }

  assert.ok(sawMarker >= 8, `the planted text did reach the answers (${sawMarker} tools), so the check above means something`);

  // Rule 1: after every tool has run, nothing was released and nothing can be sent.
  assert.deepEqual(await releasedCount(s.user.id), { active: 0, outgoing: 0, scheduledInRunning: 0 });
  assert.equal(
    await prisma.sequence.count({ where: { userId: s.user.id, runId: s.runId, approvedByUserId: { not: null }, status: "draft" } }),
    0,
    "no draft carries an approval"
  );
  const awaiting = await prisma.sequence.findUniqueOrThrow({ where: { id: world.draft1 } });
  assert.equal(awaiting.status, "draft");
  assert.equal(awaiting.approvalStatus, "awaiting_approval");

  const { senders, calls: sent } = spySenders();
  for (const daysAhead of [0, 1, 7, 60]) {
    await runSendTick({ senders, now: new Date(Date.now() + daysAhead * 86_400_000) });
  }
  assert.equal(sent.length, 0, "the send processor finds nothing to send");

  // Rule 6: the shape of every answer is fixed. A new field shows up here and is reviewed.
  if (process.env.UPDATE_SNAPSHOTS === "1" || !fs.existsSync(SHAPES_FILE)) {
    fs.mkdirSync(path.dirname(SHAPES_FILE), { recursive: true });
    fs.writeFileSync(SHAPES_FILE, JSON.stringify(shapes, null, 2) + "\n");
  }
  const expected = JSON.parse(fs.readFileSync(SHAPES_FILE, "utf8"));
  for (const name of toolNames) {
    assert.deepEqual(shapes[name], expected[name], `the shape of ${name}'s answer changed`);
  }
  await s.close();
});

test("rule 1: no tool accepts an input that asks it to release or send", async () => {
  const s = await startSession(app.mcpUrl);
  const world = await buildWorld(s.user.id, s.runId);
  const before = await snapshotOf(s.user.id);
  const tools = (await s.client.listTools()).tools;
  const calls = new Map(callsFor(world, s.runId));

  const hostileFields = [
    { status: "active" },
    { activate: true },
    { approve: true },
    { approved_by: s.user.id },
    { approval_status: "approved" },
    { send_now: true },
    { user_id: s.user.id },
  ];

  for (const tool of tools) {
    const properties = Object.keys((tool.inputSchema.properties ?? {}) as object);
    for (const extra of hostileFields) {
      const field = Object.keys(extra)[0];
      if (properties.includes(field)) {
        // The only tools with such a field are read-only filters.
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} has a "${field}" input`);
        continue;
      }
      const res = await s.call(tool.name, { ...calls.get(tool.name), ...extra });
      assert.equal(res.isError, true, `${tool.name} accepted ${JSON.stringify(extra)}`);
    }
  }

  assert.equal(await snapshotOf(s.user.id), before, "none of these calls changed anything");
  assert.deepEqual(await releasedCount(s.user.id), { active: 0, outgoing: 0, scheduledInRunning: 0 });
  await s.close();
});

// ── rule 3 ───────────────────────────────────────────────────────────

test("rule 3: one user's tools cannot read or change another user's records", async () => {
  const alice = await startSession(app.mcpUrl);
  const bob = await makeUser();
  const bobsRun = await makeRun(bob.id, { instruction: `${MARKER} instruction` });
  const bobsWorld = await buildWorld(bob.id, bobsRun.id, "bob");
  const before = await snapshotOf(bob.id);
  const bobsIds = Object.values(bobsWorld).filter((v) => v !== bob.id);
  // Alice allows Claude everything, so ownership is proved with every switch on.
  await alice.api("PATCH", "/settings", {
    sendTimezone: "Europe/London",
    claudeCanActivate: true,
    claudeCanResume: true,
    claudeCanEditSettings: true,
    claudeCanDeleteLeads: true,
    claudeCanClearDoNotContact: true,
  });

  const refused = new Set(["NOT_FOUND", "RUN_NOT_FOUND"]);
  const hasIds = (args: Record<string, unknown>) =>
    JSON.stringify(args).split('"').some((part) => bobsIds.includes(part));

  // Every tool, with Alice's token and Alice's run, but Bob's ids.
  for (const [name, args] of callsFor(bobsWorld, alice.runId)) {
    if (name === "finish_run") continue; // keeps Alice's run open for the calls below
    const res = await alice.call(name, args);
    const text = res.text;

    assert.equal(text.includes(MARKER), false, `${name} showed Bob's data`);
    for (const id of bobsIds) {
      const echoedBack = JSON.stringify(args).includes(id) && /lead_id|sequence_id/.test(text);
      assert.ok(!text.includes(id) || echoedBack, `${name} returned one of Bob's ids`);
    }

    if (!hasIds(args)) continue; // a tool without ids simply works on Alice's own data

    const code = res.data?.error?.code;
    const perItem = res.data?.results?.[0];
    const ok =
      refused.has(code) ||
      (perItem && (perItem.outcome === "rejected" || perItem.reason === "lead_not_found"));
    assert.ok(ok, `${name} with another user's id was not refused: ${text.slice(0, 200)}`);
  }

  // Bob's run id, used as Alice's run or read directly.
  const asRun = await alice.call("create_lead", { run_id: bobsRun.id, name: "X", email: "x@example.com" });
  assert.equal(asRun.data.error.code, "RUN_NOT_FOUND");
  assert.equal((await alice.call("get_run", { run_id: bobsRun.id })).data.error.code, "RUN_NOT_FOUND");
  assert.equal((await alice.call("finish_run", { run_id: bobsRun.id, summary: "Mine" })).data.error.code, "RUN_NOT_FOUND");
  assert.equal((await alice.call("list_sequences", { in_run: bobsRun.id })).data.total, 0);
  assert.equal((await alice.call("list_sequences", { lead_id: bobsWorld.lead1 })).data.total, 0);

  assert.equal(await snapshotOf(bob.id), before, "nothing of Bob's changed");
  assert.equal(await prisma.agentRunEvent.count({ where: { runId: bobsRun.id } }), 0);
  await alice.close();
});

// ── rule 7 ───────────────────────────────────────────────────────────

test("rule 7: every write tool is called twice and the second call changes nothing", async () => {
  const s = await startSession(app.mcpUrl);
  const world = await buildWorld(s.user.id, s.runId);
  const tools = (await s.client.listTools()).tools;
  const writes = new Set(tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name));
  assert.equal(writes.size, 25);

  const checked: string[] = [];

  for (const [name, args] of callsFor(world, s.runId)) {
    const first = await s.call(name, args);
    if (!writes.has(name)) continue;

    if (!EXPECTED_ERRORS[name]) assert.equal(first.isError, false, `${name}: ${first.text.slice(0, 200)}`);
    const afterFirst = await snapshotOf(s.user.id);

    const second = await s.call(name, args);
    if (!EXPECTED_ERRORS[name]) assert.equal(second.isError, false, `${name} (repeat): ${second.text.slice(0, 200)}`);
    const afterSecond = await snapshotOf(s.user.id);

    assert.equal(afterSecond, afterFirst, `${name}: the repeated call changed the data`);
    checked.push(name);
  }

  assert.deepEqual(checked.sort(), [...writes].sort(), "all 25 write tools were called twice");

  // No duplicate of anything was made along the way.
  assert.equal(await prisma.lead.count({ where: { userId: s.user.id, email: "new.person@example.com" } }), 1);
  assert.equal(await prisma.lead.count({ where: { userId: s.user.id, email: "imported.person@example.com" } }), 1);
  assert.equal(await prisma.sequence.count({ where: { runId: s.runId, leadId: world.lead5 } }), 1);
  assert.equal(await prisma.leadTranscript.count({ where: { leadId: world.lead2 } }), 1);
  assert.equal(await prisma.promptTemplate.count({ where: { userId: s.user.id } }), 2);
  assert.equal(await prisma.sequenceGoal.count({ where: { userId: s.user.id } }), 2);
  assert.equal(await prisma.suppressedContact.count({ where: { userId: s.user.id } }), 2);
  assert.equal(await prisma.agentRun.count({ where: { userId: s.user.id } }), 2);
  await s.close();
});

// ── rule 4 ───────────────────────────────────────────────────────────

test("rule 4: a do-not-contact lead, and its address imported again, cannot be drafted, approved, activated, sent or cleared by a tool", async () => {
  const s = await startSession(app.mcpUrl);
  await s.api("PATCH", "/settings", { sendTimezone: "Europe/London" });
  const { token } = await makeAccessToken(s.user.id, "second");
  const plan = [{ step_number: 1, channel: "email", delay_days: 0 }];

  const created = await s.write("create_lead", { name: "Rita Okoye", email: "rita@example.com", phone: "+15550100777" });
  const leadId = created.data.lead.lead_id;
  const draft = await s.write("create_draft_sequences", { lead_ids: [leadId], steps: plan });
  const sequenceId = draft.data.results[0].sequence_id;
  await s.write("write_steps", { sequence_id: sequenceId, steps: [{ step_number: 1, subject: "Hello Rita", body: "Good to meet you." }] });

  // Claude marks the lead
  assert.equal((await s.write("mark_lead_do_not_contact", { lead_id: leadId, reason: "Unsubscribed", requested_by: "lead" })).isError, false);

  // not approved
  const asked = await s.write("request_approval", { sequence_ids: [sequenceId] });
  assert.equal(asked.data.results[0].outcome, "rejected");
  // not activated, even by a person
  const activate = await s.api("PATCH", `/sequences/${sequenceId}`, { status: "active" });
  assert.equal(activate.status, 400);
  assert.match(activate.body.message, /do-not-contact/);
  // not sent, even if the database said "active" and "due"
  await prisma.sequence.update({ where: { id: sequenceId }, data: { status: "active", approvalStatus: "approved", approvedAt: new Date(), approvedByUserId: s.user.id } });
  await prisma.sequenceStep.updateMany({ where: { sequenceId }, data: { status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) } });
  const { senders, calls } = spySenders();
  await runSendTick({ senders });
  assert.equal(calls.length, 0);

  // not cleared: no tool exists, and the REST endpoint refuses an access token
  const cleared = await apiClient(app.url, token)("POST", `/leads/${leadId}/do-not-contact/clear`, { reason: "Let me" });
  assert.equal(cleared.status, 401);
  // the clear tool: off by default, and refused for the lead's own opt-out even when on
  assert.equal((await s.write("clear_do_not_contact", { lead_id: leadId, reason: "Let me" })).data.error.code, "HUMAN_ONLY");
  await s.api("PATCH", "/settings", { claudeCanClearDoNotContact: true });
  const optOut = await s.write("clear_do_not_contact", { lead_id: leadId, reason: "Let me" });
  assert.equal(optOut.data.error.code, "HUMAN_ONLY");
  assert.match(optOut.data.error.message, /asked not to be contacted/);
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).doNotContact, true);
  await s.api("PATCH", "/settings", { claudeCanClearDoNotContact: false });
  assert.equal((await s.write("update_lead", { lead_id: leadId, do_not_contact: false })).isError, true);

  // the lead is deleted, and the same address comes back three ways
  assert.equal((await s.api("DELETE", `/leads/${leadId}`)).status, 200);
  const viaTool = await s.write("import_leads", { rows: [{ name: "Rita Again", email: "RITA@example.com" }] });
  assert.equal(viaTool.data.blocked_as_do_not_contact, 1);
  const again = await prisma.lead.findFirstOrThrow({ where: { userId: s.user.id, name: "Rita Again" } });
  assert.equal(again.doNotContact, true);
  await prisma.lead.delete({ where: { id: again.id } });

  const viaPhone = await s.write("create_lead", { name: "Rita By Phone", phone: "+1 555 010 0777" });
  assert.equal(viaPhone.data.do_not_contact, true);
  await importLeadRows(s.user.id, [{ name: "Rita From A File", email: "rita@example.com" }]);
  const fromFile = await prisma.lead.findFirstOrThrow({ where: { userId: s.user.id, name: "Rita From A File" } });
  assert.equal(fromFile.doNotContact, true);

  const redraft = await s.write("create_draft_sequences", { lead_ids: [fromFile.id, viaPhone.data.lead.lead_id], steps: plan });
  assert.deepEqual(redraft.data.results.map((r: any) => r.reason), ["do_not_contact", "do_not_contact"]);
  assert.equal(await prisma.sequence.count({ where: { userId: s.user.id, status: "active" } }), 0);
  await s.close();
});

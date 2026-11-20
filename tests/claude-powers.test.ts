// The Claude actions behind workspace switches: activate_sequence,
// resume_sequence, update_workspace_settings, delete_lead and
// clear_do_not_contact. For each: switch off → HUMAN_ONLY, switch on → works,
// a repeat changes nothing. Synthetic example.com data on the local test database only.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  apiClient,
  makeAccessToken,
  makeLead,
  makeSequence,
  makeStep,
  prisma,
  resetDb,
  startApp,
  startSession,
} from "./helpers/setup";
import { resetRateLimits } from "../src/harness/rate-limit";
import { runSendTick } from "../src/shared/services/send-processor";
import { isInsideSendWindow, type SendWindow } from "../src/harness/send-window";
import { purgeDeletedLeads } from "../src/harness/lead-delete";

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

type Session = Awaited<ReturnType<typeof startSession>>;

const PLAN = [
  { step_number: 1, channel: "email", delay_days: 0 },
  { step_number: 2, channel: "sms", delay_days: 2 },
];

/** Email and SMS "set up" (presence is what counts; mock mode never reads them). */
const sendingSetUp = (userId: string, extra: Record<string, unknown> = {}) => {
  const fields = {
      smtpHost: "SECRET-HOST.example.com",
      smtpPort: 587,
      smtpUsername: "SECRET-USER@example.com",
      smtpPassword: "SECRET-PASSWORD",
      smsProvider: "twilio",
      twilioAccountSid: "SECRET-SID",
      twilioAuthToken: "SECRET-TWILIO",
      twilioPhoneNumber: "+15550009999",
      aiApiKey: "SECRET-AI-KEY",
      ...extra,
  };
  return prisma.userSettings.upsert({ where: { userId }, update: fields, create: { userId, ...fields } });
};

const allow = (s: Session, fields: Record<string, unknown>) => s.api("PATCH", "/settings", fields);

/** A draft with text that passed request_approval. */
const approvedDraft = async (s: Session, leadOverrides: Record<string, unknown> = {}) => {
  const lead = await makeLead(s.user.id, leadOverrides);
  const created = await s.write("create_draft_sequences", { lead_ids: [lead.id], steps: PLAN });
  const sequenceId = created.data.results[0].sequence_id as string;
  const written = await s.write("write_steps", {
    sequence_id: sequenceId,
    steps: [
      { step_number: 1, subject: "Good to meet you", body: "Hello, thank you for your time last week." },
      { step_number: 2, body: "Hi, did you get my email?" },
    ],
  });
  assert.equal(written.isError, false, written.text);
  const asked = await s.write("request_approval", { sequence_ids: [sequenceId] });
  assert.equal(asked.data.results[0].outcome, "awaiting_approval", asked.text);
  return { lead, sequenceId };
};

const seq = (id: string) => prisma.sequence.findUniqueOrThrow({ where: { id }, include: { steps: true } });

// ── the switches themselves ──────────────────────────────────────────

test("the five switches are off by default; only a logged-in person can change them", async () => {
  const s = await startSession(app.mcpUrl);
  const profile = await s.call("get_workspace_profile", {});
  assert.deepEqual(profile.data.claude_permissions, {
    activate: false, resume: false, edit_settings: false, delete_leads: false,
    clear_do_not_contact: false, daily_activation_cap: 50,
  });

  // Claude's access token is refused by the settings route
  const asClaude = await apiClient(app.url, s.token)("PATCH", "/settings", { claudeCanActivate: true });
  assert.equal(asClaude.status, 401);
  const { token } = await makeAccessToken(s.user.id, "other");
  assert.equal((await apiClient(app.url, token)("GET", "/settings")).status, 401);

  // no tool takes a switch, even with every other switch on
  await allow(s, { claudeCanEditSettings: true });
  const sneaky = await s.write("update_workspace_settings", { claude_can_activate: true });
  assert.equal(sneaky.isError, true);
  assert.equal((await prisma.userSettings.findUniqueOrThrow({ where: { userId: s.user.id } })).claudeCanActivate, false);

  // a logged-in person turns one on
  const res = await allow(s, { claudeCanActivate: true, claudeDailyActivationCap: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.claudeCanActivate, true);
  const after = await s.call("get_workspace_profile", {});
  assert.equal(after.data.claude_permissions.activate, true);
  assert.equal(after.data.claude_permissions.daily_activation_cap, 10);
  assert.equal((await allow(s, { claudeDailyActivationCap: -1 })).status, 400);
  await s.close();
});

// ── activate_sequence ────────────────────────────────────────────────

test("activate_sequence: off → HUMAN_ONLY; on → running inside the send window; repeat changes nothing; mock sends recorded", async () => {
  const s = await startSession(app.mcpUrl);
  await sendingSetUp(s.user.id);
  await allow(s, { sendTimezone: "Europe/London" });
  const { sequenceId } = await approvedDraft(s);

  const off = await s.write("activate_sequence", { sequence_ids: [sequenceId] });
  assert.equal(off.data.error.code, "HUMAN_ONLY");
  assert.match(off.data.error.message, /Claude can activate sequences/);
  assert.match(off.data.error.next_step, /Settings → Claude permissions/);
  assert.equal((await seq(sequenceId)).status, "draft");

  await allow(s, { claudeCanActivate: true });
  const on = await s.write("activate_sequence", { sequence_ids: [sequenceId] });
  assert.equal(on.isError, false, on.text);
  assert.equal(on.data.activated, 1);
  assert.equal(on.data.results[0].outcome, "activated");
  assert.equal(on.data.outbound_mode, "mock");

  const running = await seq(sequenceId);
  assert.equal(running.status, "active");
  assert.equal(running.approvalStatus, "approved");
  assert.equal(running.approvedByActor, "claude");
  assert.equal(running.approvedByUserId, s.user.id);
  assert.ok(running.approvedContentHash);
  const window: SendWindow = { startMinutes: 540, endMinutes: 1080, weekends: false, timeZone: "Europe/London" };
  for (const step of running.steps) {
    assert.equal(step.status, "scheduled");
    assert.ok(isInsideSendWindow(step.scheduledAt, window), `step ${step.stepOrder} inside the window`);
  }
  const activity = await prisma.sequenceActivity.findFirst({
    where: { sequenceId, eventType: "sequence_status_changed" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(activity?.actor, "claude");

  // a repeat changes nothing
  const before = JSON.stringify(await seq(sequenceId));
  const again = await s.write("activate_sequence", { sequence_ids: [sequenceId] });
  assert.equal(again.data.results[0].outcome, "already_active");
  assert.equal(again.data.activated, 0);
  assert.equal(JSON.stringify(await seq(sequenceId)), before);

  // mock mode: the send processor records a mock send, nothing leaves
  const first = running.steps.find((st) => st.stepOrder === 1)!;
  await runSendTick({ now: new Date(first.scheduledAt.getTime() + 60_000) });
  const sent = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(sent.status, "sent");
  assert.equal(sent.deliveryMode, "mock");

  // the run event says what Claude did
  const event = await prisma.agentRunEvent.findFirst({ where: { runId: s.runId, toolName: "activate_sequence", ok: true } });
  assert.ok(event);
  await s.close();
});

test("activate_sequence refuses: no timezone, channel not set up, do-not-contact, a step without text, a placeholder, no approval request, the daily cap", async () => {
  const s = await startSession(app.mcpUrl);
  await allow(s, { claudeCanActivate: true });

  // no timezone: nothing at all is activated
  const a = await approvedDraft(s);
  await sendingSetUp(s.user.id);
  const noTz = await s.write("activate_sequence", { sequence_ids: [a.sequenceId] });
  assert.equal(noTz.data.error.code, "VALIDATION");
  assert.match(noTz.data.error.message, /timezone/i);
  assert.equal((await seq(a.sequenceId)).status, "draft");
  await allow(s, { sendTimezone: "Europe/London" });

  const problemsOf = async (sequenceId: string) => {
    const res = await s.write("activate_sequence", { sequence_ids: [sequenceId] });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.data.results[0].outcome, "rejected", res.text);
    assert.equal((await seq(sequenceId)).status, "draft");
    return (res.data.results[0].problems as string[]).join(" | ");
  };

  // SMS not set up
  await prisma.userSettings.update({ where: { userId: s.user.id }, data: { smsProvider: null } });
  assert.match(await problemsOf(a.sequenceId), /SMS sending is not set up/);
  await sendingSetUp(s.user.id);

  // do-not-contact (the address is on the list; the draft is left as it is)
  const b = await approvedDraft(s);
  await prisma.suppressedContact.create({
    data: { userId: s.user.id, kind: "email", value: b.lead.email!.toLowerCase(), source: "user" },
  });
  assert.match(await problemsOf(b.sequenceId), /do-not-contact/);

  // a step with no text
  const c = await approvedDraft(s);
  await prisma.sequenceStep.updateMany({ where: { sequenceId: c.sequenceId, stepOrder: 2 }, data: { content: "" } });
  assert.match(await problemsOf(c.sequenceId), /Step 2 has no text/);

  // a placeholder left
  const d = await approvedDraft(s);
  await prisma.sequenceStep.updateMany({ where: { sequenceId: d.sequenceId, stepOrder: 1 }, data: { content: "Hi {{lead.name}}" } });
  assert.match(await problemsOf(d.sequenceId), /\{\{lead\.name\}\}/);

  // a draft that never passed request_approval
  const lead = await makeLead(s.user.id);
  const fresh = await s.write("create_draft_sequences", { lead_ids: [lead.id], steps: PLAN });
  assert.match(await problemsOf(fresh.data.results[0].sequence_id), /request_approval/);

  // the daily cap
  await allow(s, { claudeDailyActivationCap: 1 });
  const e = await approvedDraft(s);
  const f = await approvedDraft(s);
  const capped = await s.write("activate_sequence", { sequence_ids: [e.sequenceId, f.sequenceId] });
  assert.deepEqual(capped.data.results.map((r: any) => r.outcome), ["activated", "rejected"]);
  assert.match(capped.data.results[1].problems[0], /daily limit of 1/);
  assert.equal(capped.data.activations_left_today, 0);
  assert.equal((await seq(f.sequenceId)).status, "draft");

  // more than 25 in one call is refused by the input check
  const many = Array.from({ length: 26 }, () => a.sequenceId.replace(/.$/, "0"));
  assert.equal((await s.write("activate_sequence", { sequence_ids: many })).isError, true);
  await s.close();
});

// ── resume_sequence ──────────────────────────────────────────────────

test("resume_sequence follows its switch and resumes a sequence Claude activated", async () => {
  const s = await startSession(app.mcpUrl);
  await sendingSetUp(s.user.id);
  await allow(s, { sendTimezone: "Europe/London", claudeCanActivate: true });
  const { sequenceId } = await approvedDraft(s);
  await s.write("activate_sequence", { sequence_ids: [sequenceId] });
  await s.write("pause_sequence", { sequence_id: sequenceId });

  assert.equal((await s.write("resume_sequence", { sequence_id: sequenceId })).data.error.code, "HUMAN_ONLY");
  await allow(s, { claudeCanResume: true });
  const resumed = await s.write("resume_sequence", { sequence_id: sequenceId });
  assert.equal(resumed.isError, false, resumed.text);
  assert.equal((await seq(sequenceId)).status, "active");
  assert.equal((await s.write("resume_sequence", { sequence_id: sequenceId })).data.was_already_active, true);
  await s.close();
});

// ── update_workspace_settings ────────────────────────────────────────

test("update_workspace_settings: off → HUMAN_ONLY; on → only the listed fields, checked; repeat changes nothing; no secret in or out", async () => {
  const s = await startSession(app.mcpUrl);
  await sendingSetUp(s.user.id);
  const settingsNow = () => prisma.userSettings.findUniqueOrThrow({ where: { userId: s.user.id } });

  assert.equal((await s.write("update_workspace_settings", { timezone: "Europe/London" })).data.error.code, "HUMAN_ONLY");
  assert.equal((await settingsNow()).sendTimezone, null);

  await allow(s, { claudeCanEditSettings: true });
  const changed = await s.write("update_workspace_settings", {
    timezone: "Asia/Dhaka",
    sender_name: "Sam Rivera",
    sender_company: "Rivera Vans",
    sender_position: "Owner",
    service_description: "Van leasing for small firms.",
    booking_link: "https://cal.example.com/sam",
    send_window_start: "08:30",
    send_window_end: "17:00",
    send_on_weekends: true,
  });
  assert.equal(changed.isError, false, changed.text);
  assert.equal(changed.data.changed_fields.length, 9);
  const after = await settingsNow();
  assert.equal(after.sendTimezone, "Asia/Dhaka");
  assert.equal(after.bookingLink, "https://cal.example.com/sam");
  assert.equal(after.sendWindowStart, "08:30");
  assert.equal(after.sendOnWeekends, true);
  assert.equal(after.smtpPassword, "SECRET-PASSWORD", "credentials untouched");
  assert.equal(changed.text.includes("SECRET"), false);

  // a repeat changes nothing
  const before = JSON.stringify(await settingsNow());
  const again = await s.write("update_workspace_settings", { timezone: "Asia/Dhaka", booking_link: "https://cal.example.com/sam" });
  assert.equal(again.data.unchanged, true);
  const { updatedAt: _a, ...x } = JSON.parse(before);
  const { updatedAt: _b, ...y } = JSON.parse(JSON.stringify(await settingsNow()));
  assert.deepEqual(y, x);

  // checks
  const bad = async (args: Record<string, unknown>) => {
    const res = await s.write("update_workspace_settings", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    return res;
  };
  assert.equal((await bad({ timezone: "Mars/Olympus" })).data.error.code, "VALIDATION");
  assert.equal((await bad({ booking_link: "http://cal.example.com/sam" })).data.error.code, "VALIDATION");
  assert.equal((await bad({ booking_link: "javascript:alert(1)" })).data.error.code, "VALIDATION");
  assert.equal((await bad({ send_window_start: "18:00", send_window_end: "09:00" })).data.error.code, "VALIDATION");
  // credentials and anything else unknown are refused by the strict input
  for (const field of ["smtp_password", "smtpPassword", "twilio_auth_token", "ai_api_key", "api_key", "password", "sms_provider", "claude_can_delete_leads"]) {
    await bad({ [field]: "x" });
  }
  assert.equal(JSON.stringify(await settingsNow()), JSON.stringify(await settingsNow()));
  assert.equal((await settingsNow()).sendTimezone, "Asia/Dhaka", "nothing changed by the refused calls");

  const profile = await s.call("get_workspace_profile", {});
  assert.equal(profile.data.booking_link, "https://cal.example.com/sam");
  assert.equal(profile.text.includes("SECRET"), false);
  await s.close();
});

// ── delete_lead ──────────────────────────────────────────────────────

test("delete_lead: off → HUMAN_ONLY; on → hidden, sequences stopped, do-not-contact kept, restorable for 30 days; repeat changes nothing", async () => {
  const s = await startSession(app.mcpUrl);
  const lead = await makeLead(s.user.id, { name: "Dana Gone", email: "dana.gone@example.com", phone: "+15550100222" });
  const running = await makeSequence(s.user.id, lead.id, { status: "active" });
  await makeStep(running.id, { status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });
  const draft = await makeSequence(s.user.id, lead.id, { status: "draft" });
  await makeStep(draft.id, { status: "draft" });
  await s.write("mark_lead_do_not_contact", { lead_id: lead.id, reason: "User said so", requested_by: "user" });

  assert.equal((await s.write("delete_lead", { lead_id: lead.id, reason: "Duplicate" })).data.error.code, "HUMAN_ONLY");
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt, null);

  await allow(s, { claudeCanDeleteLeads: true });
  assert.equal((await s.write("delete_lead", { lead_id: lead.id, reason: "" })).isError, true, "a reason is required");
  const deleted = await s.write("delete_lead", { lead_id: lead.id, reason: "Duplicate of another lead" });
  assert.equal(deleted.isError, false, deleted.text);
  assert.equal(deleted.data.already_deleted, false);
  assert.equal(deleted.data.do_not_contact_kept, true);

  const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
  assert.ok(row.deletedAt);
  assert.equal(row.deletedBy, "claude");
  assert.equal(row.deletedReason, "Duplicate of another lead");
  for (const id of [running.id, draft.id]) {
    const sq = await seq(id);
    assert.equal(sq.status, "cancelled");
    assert.ok(sq.steps.every((st) => st.status === "skipped"));
  }
  assert.equal(await prisma.suppressedContact.count({ where: { userId: s.user.id, clearedAt: null } }), 2, "the block stays");

  // hidden everywhere
  assert.equal((await s.call("search_leads", { query: "Dana" })).data.total, 0);
  assert.equal((await s.call("get_lead", { lead_id: lead.id })).data.error.code, "NOT_FOUND");
  assert.equal((await s.api("GET", "/leads")).body.data.items.length, 0);
  assert.equal((await s.api("GET", `/leads/${lead.id}`)).status, 404);
  const createAgain = await s.write("create_lead", { name: "Dana Again", email: "dana.gone@example.com" });
  assert.equal(createAgain.data.error.code, "CONFLICT");

  // a repeat changes nothing
  const again = await s.write("delete_lead", { lead_id: lead.id, reason: "Duplicate of another lead" });
  assert.equal(again.data.already_deleted, true);
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt?.getTime(), row.deletedAt!.getTime());

  // the app lists and restores it; a restore does not restart anything
  const list = await s.api("GET", "/leads/deleted");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.ok(list.body.data[0].restorableUntil);
  assert.equal((await apiClient(app.url, s.token)("POST", `/leads/${lead.id}/restore`)).status, 401, "not with Claude's token");
  const restored = await s.api("POST", `/leads/${lead.id}/restore`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.deletedAt, null);
  assert.equal((await s.call("search_leads", { query: "Dana" })).data.total, 1);
  assert.equal((await seq(running.id)).status, "cancelled");
  assert.equal((await s.api("POST", `/leads/${lead.id}/restore`)).status, 404);

  // after 30 days: not restorable, and removed for good by the daily job; the block stays
  await s.write("delete_lead", { lead_id: lead.id, reason: "Gone again" });
  await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
  assert.equal((await s.api("POST", `/leads/${lead.id}/restore`)).status, 410);
  assert.equal((await s.api("GET", "/leads/deleted")).body.data.length, 0);
  assert.ok((await purgeDeletedLeads()) >= 1);
  assert.equal(await prisma.lead.count({ where: { id: lead.id } }), 0);
  assert.equal(await prisma.suppressedContact.count({ where: { userId: s.user.id, clearedAt: null } }), 2);
  await s.close();
});

// ── clear_do_not_contact ─────────────────────────────────────────────

test("clear_do_not_contact: off → HUMAN_ONLY; on → clears a block set by Claude or the user, with the reason; never a lead's own opt-out; restarts nothing", async () => {
  const s = await startSession(app.mcpUrl);
  const lead = await makeLead(s.user.id, { email: "mistake@example.com", phone: "+15550100444" });
  const running = await makeSequence(s.user.id, lead.id, { status: "active" });
  await makeStep(running.id, { status: "scheduled", scheduledAt: new Date(Date.now() + 86_400_000) });
  await s.write("mark_lead_do_not_contact", { lead_id: lead.id, reason: "Wrong lead", requested_by: "user" });
  assert.equal((await seq(running.id)).status, "paused");

  assert.equal((await s.write("clear_do_not_contact", { lead_id: lead.id, reason: "Set by mistake" })).data.error.code, "HUMAN_ONLY");
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact, true);

  await allow(s, { claudeCanClearDoNotContact: true });
  assert.equal((await s.write("clear_do_not_contact", { lead_id: lead.id })).isError, true, "a reason is required");
  const cleared = await s.write("clear_do_not_contact", { lead_id: lead.id, reason: "Set by mistake" });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(cleared.data.already_clear, false);
  assert.equal(cleared.data.addresses_cleared, 2);
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact, false);
  const rows = await prisma.suppressedContact.findMany({ where: { userId: s.user.id } });
  assert.ok(rows.every((r) => r.clearedAt && r.clearReason === "Set by mistake"), "the reason is kept");
  assert.equal((await seq(running.id)).status, "paused", "nothing restarts");

  const again = await s.write("clear_do_not_contact", { lead_id: lead.id, reason: "Set by mistake" });
  assert.equal(again.data.already_clear, true);

  // the lead asked: refused, always
  const asked = await makeLead(s.user.id, { email: "asked@example.com", phone: "+15550100555" });
  await s.write("mark_lead_do_not_contact", { lead_id: asked.id, reason: "Replied: please stop", requested_by: "lead" });
  const refused = await s.write("clear_do_not_contact", { lead_id: asked.id, reason: "I think it is fine" });
  assert.equal(refused.data.error.code, "HUMAN_ONLY");
  assert.match(refused.data.error.message, /asked not to be contacted/);
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: asked.id } })).doNotContact, true);

  // a block Claude set first, then the lead asked too: now the lead's own opt-out
  const both = await makeLead(s.user.id, { email: "both@example.com", phone: null });
  await s.write("mark_lead_do_not_contact", { lead_id: both.id, reason: "User said", requested_by: "user" });
  await s.write("mark_lead_do_not_contact", { lead_id: both.id, reason: "Lead said", requested_by: "lead" });
  assert.equal((await s.write("clear_do_not_contact", { lead_id: both.id, reason: "x" })).data.error.code, "HUMAN_ONLY");
  await s.close();
});

// ── the app shows these actions as "by Claude" ───────────────────────

test("the Activity Log shows Claude's lead, do-not-contact and settings actions with actor claude", async () => {
  const s = await startSession(app.mcpUrl);
  await allow(s, { claudeCanDeleteLeads: true, claudeCanClearDoNotContact: true, claudeCanEditSettings: true });
  const a = await makeLead(s.user.id, { name: "To Delete" });
  const b = await makeLead(s.user.id, { name: "To Clear" });
  await s.write("mark_lead_do_not_contact", { lead_id: b.id, reason: "Oops", requested_by: "user" });
  await s.write("delete_lead", { lead_id: a.id, reason: "Not a real lead" });
  await s.write("clear_do_not_contact", { lead_id: b.id, reason: "Oops, wrong lead" });
  await s.write("update_workspace_settings", { sender_name: "Sam" });
  await s.write("update_workspace_settings", { sender_name: "Sam" }); // no change: not shown

  const res = await s.api("GET", "/activity");
  assert.equal(res.status, 200);
  const mine = res.body.data.events.filter((e: any) =>
    ["lead_deleted", "do_not_contact_cleared", "settings_changed"].includes(e.type)
  );
  assert.deepEqual(mine.map((e: any) => e.type).sort(), ["do_not_contact_cleared", "lead_deleted", "settings_changed"]);
  assert.ok(mine.every((e: any) => e.actor === "claude"));
  const clear = mine.find((e: any) => e.type === "do_not_contact_cleared");
  assert.equal(clear.untrusted_details.reason, "Oops, wrong lead");
  assert.equal(clear.lead_id, b.id);

  const viaTool = await s.call("list_recent_activity", { types: ["lead_deleted"] });
  assert.equal(viaTool.data.events.length, 1);
  await s.close();
});

// ── no secret in, no secret out ──────────────────────────────────────

test("no tool takes a key, password or provider credential, and the new tools return none, with every switch on", async () => {
  const s = await startSession(app.mcpUrl);
  await sendingSetUp(s.user.id);
  await allow(s, {
    sendTimezone: "Europe/London",
    claudeCanActivate: true, claudeCanResume: true, claudeCanEditSettings: true,
    claudeCanDeleteLeads: true, claudeCanClearDoNotContact: true,
  });

  const tools = (await s.client.listTools()).tools;
  for (const tool of tools) {
    const fields = Object.keys((tool.inputSchema.properties ?? {}) as object);
    for (const field of fields) {
      assert.doesNotMatch(field, /password|api_?key|secret|token|smtp|twilio|textmagic|retell|fathom|credential|sms_provider/i, `${tool.name}.${field}`);
    }
  }

  const { sequenceId, lead } = await approvedDraft(s);
  const answers = [
    await s.write("activate_sequence", { sequence_ids: [sequenceId] }),
    await s.write("pause_sequence", { sequence_id: sequenceId }),
    await s.write("resume_sequence", { sequence_id: sequenceId }),
    await s.write("update_workspace_settings", { sender_name: "Sam" }),
    await s.write("mark_lead_do_not_contact", { lead_id: lead.id, reason: "test", requested_by: "user" }),
    await s.write("clear_do_not_contact", { lead_id: lead.id, reason: "test" }),
    await s.write("delete_lead", { lead_id: lead.id, reason: "test" }),
    await s.call("get_workspace_profile", {}),
  ];
  for (const answer of answers) {
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.text.includes("SECRET"), false, answer.text.slice(0, 200));
    assert.equal(answer.text.includes(s.token), false);
  }
  await s.close();
});

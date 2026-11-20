// PHASE 5, rule 5: limits on everything. Each limit is tried AT the limit
// (accepted) and ONE ABOVE it (refused). Limits already proven the same way
// in other files are listed at the bottom.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { makeLead, prisma, resetDb, startApp, startSession } from "./helpers/setup";
import { LIMITS } from "../src/harness/limits";
import { resetRateLimits } from "../src/harness/rate-limit";

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

const x = (n: number) => "x".repeat(n);
const EMAIL_STEP = [{ step_number: 1, channel: "email", delay_days: 0 }];

test("text limits: accepted at the limit, refused one character above", async () => {
  const s = await startSession(app.mcpUrl);
  const lead = await makeLead(s.user.id);
  const other = await makeLead(s.user.id);
  const draft = (await s.write("create_draft_sequences", { lead_ids: [lead.id], steps: EMAIL_STEP })).data.results[0].sequence_id;
  const template = (await s.write("create_template", { name: "T", follow_up_stage: "Stage A", prompt_text: "Ten chars!" })).data.template.template_id;

  // [what, tool, arguments for a text of n characters, the limit]
  const cases: [string, string, (n: number) => Record<string, unknown>, number][] = [
    ["lead name", "update_lead", (n) => ({ lead_id: lead.id, name: x(n) }), 150],
    ["lead notes", "update_lead", (n) => ({ lead_id: lead.id, notes: x(n) }), LIMITS.NOTES_MAX],
    ["do-not-contact reason", "mark_lead_do_not_contact", (n) => ({ lead_id: other.id, reason: x(n), requested_by: "user" }), LIMITS.REASON_MAX],
    ["sequence name", "update_sequence", (n) => ({ sequence_id: draft, name: x(n) }), LIMITS.SEQUENCE_NAME_MAX],
    ["goal on a sequence", "update_sequence", (n) => ({ sequence_id: draft, goal: x(n) }), LIMITS.GOAL_NAME_MAX],
    ["goal label", "save_goal", (n) => ({ label: x(n) }), LIMITS.GOAL_NAME_MAX],
    ["template name", "update_template", (n) => ({ template_id: template, name: x(n) }), LIMITS.TEMPLATE_NAME_MAX],
    ["template stage", "update_template", (n) => ({ template_id: template, follow_up_stage: x(n) }), 50],
    ["template text", "update_template", (n) => ({ template_id: template, prompt_text: x(n) }), LIMITS.TEMPLATE_PROMPT_MAX],
    ["transcript title", "add_lead_transcript", (n) => ({ lead_id: other.id, meeting_title: x(n), meeting_date: "2026-11-01", text: `Notes ${n}` }), 150],
    ["email subject", "write_steps", (n) => ({ sequence_id: draft, steps: [{ step_number: 1, subject: x(n), body: "Hello." }] }), LIMITS.EMAIL_SUBJECT_MAX],
    ["email body", "write_steps", (n) => ({ sequence_id: draft, steps: [{ step_number: 1, subject: "Hi", body: x(n) }] }), LIMITS.EMAIL_BODY_MAX],
    ["approval note", "request_approval", (n) => ({ sequence_ids: [draft], note: x(n) }), LIMITS.REASON_MAX],
  ];

  for (const [what, tool, args, limit] of cases) {
    const over = await s.write(tool, args(limit + 1));
    assert.equal(over.isError, true, `${what}: ${limit + 1} characters must be refused`);
    const at = await s.write(tool, args(limit));
    assert.equal(at.isError, false, `${what}: ${limit} characters must be accepted (${at.text.slice(0, 160)})`);
  }

  // the run summary, last, because it closes the run
  assert.equal((await s.write("finish_run", { summary: x(LIMITS.RUN_SUMMARY_MAX + 1) })).isError, true);
  assert.equal((await s.write("finish_run", { summary: x(LIMITS.RUN_SUMMARY_MAX) })).isError, false);
  await s.close();
});

test("count limits: leads per call, sequences per call, pages, transcripts named, transcripts pasted", async () => {
  const s = await startSession(app.mcpUrl);

  // leads per create_draft_sequences call
  const leads = [];
  for (let i = 0; i < LIMITS.LEADS_PER_BULK_CALL + 1; i++) leads.push((await makeLead(s.user.id)).id);
  const tooMany = await s.write("create_draft_sequences", { lead_ids: leads, steps: EMAIL_STEP });
  assert.equal(tooMany.isError, true, "26 leads in one call");
  assert.equal(await prisma.sequence.count(), 0);
  const atLimit = await s.write("create_draft_sequences", { lead_ids: leads.slice(0, LIMITS.LEADS_PER_BULK_CALL), steps: EMAIL_STEP });
  assert.equal(atLimit.isError, false, atLimit.text.slice(0, 200));
  assert.equal(atLimit.data.created, LIMITS.LEADS_PER_BULK_CALL);

  // sequences per request_approval call
  const ids = atLimit.data.results.map((r: any) => r.sequence_id);
  assert.equal((await s.write("request_approval", { sequence_ids: [...ids, randomUUID()] })).isError, true, "26 sequences in one call");
  const asked = await s.write("request_approval", { sequence_ids: ids });
  assert.equal(asked.isError, false);
  assert.equal(asked.data.rejected, LIMITS.LEADS_PER_BULK_CALL, "accepted as a call; each draft is rejected because it has no text yet");

  // page sizes
  const pages: [string, Record<string, unknown>, number][] = [
    ["search_leads", {}, LIMITS.PAGE_SIZE_MAX],
    ["list_sequences", {}, LIMITS.PAGE_SIZE_MAX],
    ["list_recent_activity", {}, LIMITS.PAGE_SIZE_MAX],
    ["get_sequence_activity", { sequence_id: ids[0] }, LIMITS.PAGE_SIZE_MAX],
    ["list_lead_replies", { lead_id: leads[0] }, 20],
    ["list_runs", {}, LIMITS.RUN_SEQUENCES_PER_READ_MAX],
    ["get_run", { run_id: s.runId }, LIMITS.RUN_SEQUENCES_PER_READ_MAX],
  ];
  for (const [tool, args, max] of pages) {
    assert.equal((await s.call(tool, { ...args, page_size: max + 1 })).isError, true, `${tool}: page_size ${max + 1}`);
    const ok = await s.call(tool, { ...args, page_size: max });
    assert.equal(ok.isError, false, `${tool}: page_size ${max} (${ok.text.slice(0, 160)})`);
  }
  // a full page never comes back larger than asked
  assert.equal((await s.call("list_sequences", { page_size: 10 })).data.sequences.length, 10);

  // transcripts named as the basis of a step: 3 accepted, 4 refused
  const lead = leads[LIMITS.LEADS_PER_BULK_CALL];
  const transcripts = [];
  for (let i = 0; i < 4; i++) {
    const t = await prisma.leadTranscript.create({
      data: { userId: s.user.id, leadId: lead, source: "manual", meetingTitle: `Call ${i}`, meetingDate: new Date(Date.now() - (i + 1) * 86_400_000), transcript: `Call number ${i}.` },
    });
    transcripts.push(t.id);
    await s.write("get_lead_transcript", { lead_id: lead, transcript_id: t.id });
  }
  const draft = (await s.write("create_draft_sequences", { lead_ids: [lead], steps: EMAIL_STEP })).data.results[0].sequence_id;
  const withIds = (n: number) =>
    s.write("write_steps", { sequence_id: draft, steps: [{ step_number: 1, subject: "Hi", body: "Hello.", based_on_transcript_ids: transcripts.slice(0, n) }] });
  assert.equal((await withIds(LIMITS.BASED_ON_TRANSCRIPTS_MAX + 1)).isError, true, "4 transcripts named");
  assert.equal((await withIds(LIMITS.BASED_ON_TRANSCRIPTS_MAX)).isError, false, "3 transcripts named");

  // transcripts pasted for one lead in one run: 10 accepted, the 11th refused
  const pasteLead = leads[0];
  for (let i = 1; i <= LIMITS.PASTED_TRANSCRIPTS_PER_LEAD_PER_RUN; i++) {
    const res = await s.write("add_lead_transcript", { lead_id: pasteLead, meeting_title: `Notes ${i}`, meeting_date: "2026-11-01", text: `Pasted notes number ${i}.` });
    assert.equal(res.isError, false, `pasted transcript ${i}`);
  }
  const eleventh = await s.write("add_lead_transcript", { lead_id: pasteLead, meeting_title: "Notes 11", meeting_date: "2026-11-01", text: "Pasted notes number 11." });
  assert.equal(eleventh.data.error.code, "LIMIT_EXCEEDED");
  assert.equal(await prisma.leadTranscript.count({ where: { leadId: pasteLead } }), LIMITS.PASTED_TRANSCRIPTS_PER_LEAD_PER_RUN);
  await s.close();
});

test("a run holds at most N sequences: the Nth is created, the next is refused", async () => {
  const s = await startSession(app.mcpUrl);
  const original = LIMITS.SEQUENCES_PER_RUN;
  LIMITS.SEQUENCES_PER_RUN = 3;

  try {
    const leads = [];
    for (let i = 0; i < 4; i++) leads.push((await makeLead(s.user.id)).id);

    const three = await s.write("create_draft_sequences", { lead_ids: leads.slice(0, 3), steps: EMAIL_STEP });
    assert.equal(three.data.created, 3);
    const fourth = await s.write("create_draft_sequences", { lead_ids: [leads[3]], steps: EMAIL_STEP });
    assert.equal(fourth.data.error.code, "LIMIT_EXCEEDED");
    assert.match(fourth.data.error.next_step, /new one/);
    assert.equal(await prisma.sequence.count({ where: { runId: s.runId } }), 3);
  } finally {
    LIMITS.SEQUENCES_PER_RUN = original;
  }
  await s.close();
});

// Limits proven at the limit and one above in other files:
//   instruction 2,000 characters ............ mcp-http.test.ts
//   steps per sequence 10, delay 60 days,
//   whole sequence 90 days ................... tools-sequences.test.ts
//   SMS 480, based_on_note 200 ............... tools-sequences.test.ts
//   import rows 100, pasted transcript
//   100,000, transcript per read 20,000,
//   search page 50, reply body 4,000 ......... tools-data.test.ts
//   answer size 40,000, tool calls per run,
//   tool calls per minute .................... run-events.test.ts
//   runs per hour ............................ mcp-http.test.ts
//   tokens per user 10, token life 365 days .. tokens.test.ts

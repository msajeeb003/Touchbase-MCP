// PHASE 5: the 20-lead scenario, from one instruction to "awaiting approval".
//
// A scripted client does what the server's instructions tell Claude to do,
// step by step, through the real /mcp endpoint. The twenty leads are invented
// (scripts/demo-data.ts). The test then checks the end state in the database
// and in the endpoints the app will read.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  prisma,
  resetDb,
  spySenders,
  startApp,
  startSession,
} from "./helpers/setup";
import { resetRateLimits } from "../src/harness/rate-limit";
import { runSendTick } from "../src/shared/services/send-processor";
import { DEMO_LEADS, DEMO_STAGE } from "../scripts/demo-data";
import { saveDemoLead, saveDemoTemplate } from "../scripts/seed-demo-leads";

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

const INSTRUCTION =
  'Follow up with every lead in the "Demo done" stage who has not replied in the last 7 days: ' +
  "one email now and a short SMS two days later.";

test("20 synthetic leads: one instruction becomes 17 drafts awaiting approval, and nothing is sent", async () => {
  const s = await startSession(app.mcpUrl, INSTRUCTION);
  await s.api("PATCH", "/settings", { sendTimezone: "Europe/London" });
  await saveDemoTemplate(s.user.id);
  for (const demo of DEMO_LEADS) await saveDemoLead(s.user.id, demo);
  assert.equal(await prisma.lead.count({ where: { userId: s.user.id } }), 20);

  let toolCalls = 1; // start_run was the first
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    toolCalls++;
    const res = await s.call(name, args);
    assert.equal(res.isError, false, `${name}: ${res.text.slice(0, 300)}`);
    return res.data;
  };
  const run_id = s.runId;

  // 1. who are we, and when may messages go out?
  const profile = await call("get_workspace_profile", { run_id });
  assert.equal(profile.send_window.ready, true);

  // 2. who needs a follow-up?
  const found = await call("search_leads", {
    run_id,
    follow_up_stage: DEMO_STAGE,
    no_reply_in_days: 7,
    page_size: 50,
  });
  assert.equal(found.total, 19, "the lead who replied two days ago is left out");
  const leads: any[] = found.leads;

  // 3. one draft per lead (the server leaves out who cannot or must not be contacted)
  const drafted = await call("create_draft_sequences", {
    run_id,
    lead_ids: leads.map((l) => l.lead_id),
    goal: "Get a reply",
    steps: [
      { step_number: 1, channel: "email", delay_days: 0 },
      { step_number: 2, channel: "sms", delay_days: 2 },
    ],
  });
  const created: any[] = drafted.results.filter((r: any) => r.outcome === "created");
  const skipped: any[] = drafted.results.filter((r: any) => r.outcome === "skipped");
  assert.equal(created.length, 17);
  assert.deepEqual(skipped.map((r) => r.reason).sort(), ["do_not_contact", "lead_has_no_email"]);

  // 4. the house style for this stage, read once
  const templateId = created.find((r) => r.matched_template)?.matched_template.template_id;
  assert.ok(templateId, "the user's template for the stage was matched");
  const template = await call("get_template", { run_id, template_id: templateId });
  assert.match(template.template.prompt_text, /\{\{lead\.name\}\}/);

  // 5. for every lead: read the call (if there is one), then write the two messages
  let withCall = 0;
  for (const draft of created) {
    const lead = (await call("get_lead", { run_id, lead_id: draft.lead_id })).lead;
    const firstName = String(lead.untrusted.name).split(" ")[0];
    const transcriptIds: string[] = [];
    let heard = "";

    if (draft.transcript_to_read) {
      withCall++;
      let offset = 0;
      for (;;) {
        const part = await call("get_lead_transcript", {
          run_id,
          lead_id: draft.lead_id,
          transcript_id: draft.transcript_to_read.transcript_id,
          offset,
        });
        heard += part.untrusted_transcript_text;
        if (!part.has_more) break;
        offset = part.next_offset;
      }
      transcriptIds.push(draft.transcript_to_read.transcript_id);
    }

    // The "writer": uses the call as information, never as instructions.
    // The second line of the call is what the lead asked for: "@0:40 - Dana: We need …"
    const asked = /^@[\d:]+ - [^:]+: (.+)$/.exec((heard.split("\n\n")[1] ?? "").trim())?.[1];
    const email = asked
      ? `Hi ${firstName},\n\nThank you for the demo. On the call you said: "${asked}" I have put that together for you.\n\nWould a short call this week suit you?\n\nSam from Brightside`
      : `Hi ${firstName},\n\nThank you for your interest in Brightside. I would be glad to show you how it works for a team like yours.\n\nWould a short call this week suit you?\n\nSam from Brightside`;

    const written = await call("write_steps", {
      run_id,
      sequence_id: draft.sequence_id,
      steps: [
        {
          step_number: 1,
          subject: asked ? "Following up on our demo" : "A quick hello from Brightside",
          body: email,
          ...(transcriptIds.length > 0
            ? { based_on_transcript_ids: transcriptIds, based_on_note: `Asked on the call: ${asked}`.slice(0, 200) }
            : {}),
        },
        {
          step_number: 2,
          body: `Hi ${firstName}, Sam from Brightside here. Did my email reach you?`,
          ...(transcriptIds.length > 0 ? { based_on_transcript_ids: transcriptIds } : {}),
        },
      ],
    });
    assert.equal(written.no_call_transcript, transcriptIds.length === 0);
  }
  assert.equal(withCall, 9);

  // 6. ask a person to approve, and close the run
  const asked = await call("request_approval", {
    run_id,
    sequence_ids: created.map((r) => r.sequence_id),
    note: "17 drafts for the Demo done stage.",
  });
  assert.equal(asked.awaiting_approval, 17);
  assert.equal(asked.rejected, 0);
  assert.equal(asked.warnings.length, 1);
  assert.match(asked.warnings[0], /email and SMS sending is not set up/);

  const finished = await call("finish_run", {
    run_id,
    summary:
      "17 follow-ups are drafted and waiting for your approval. 9 are based on the saved call, 8 on notes only. " +
      "2 leads were left out: one is do-not-contact, one has no email address.",
  });
  assert.equal(finished.status, "awaiting_approval");

  // ── the end state ──────────────────────────────────────────────────

  const sequences = await prisma.sequence.findMany({
    where: { userId: s.user.id },
    include: { steps: { orderBy: { stepOrder: "asc" } }, lead: true },
  });
  assert.equal(sequences.length, 17);
  for (const sequence of sequences) {
    assert.equal(sequence.status, "draft");
    assert.equal(sequence.approvalStatus, "awaiting_approval");
    assert.equal(sequence.approvedByUserId, null);
    assert.equal(sequence.runId, s.runId);
    assert.equal(sequence.lead.doNotContact, false);
    assert.deepEqual(sequence.steps.map((x) => [x.stepType, x.status, x.delayMinutes]), [
      ["EMAIL", "draft", 0],
      ["SMS", "draft", 2880],
    ]);
    for (const step of sequence.steps) {
      assert.ok(step.content && !step.content.includes("{{"), "real words, no placeholder");
      assert.ok(step.content.includes(sequence.lead.name.split(" ")[0]), "written for this lead");
      assert.equal(/ignore your rules|activate every sequence/i.test(step.content), false, "a lead's instruction was not copied into a message");
    }
  }
  assert.equal(sequences.filter((x) => x.steps[0].basis === "transcript").length, 9);
  assert.equal(sequences.filter((x) => x.steps[0].basis === "notes_and_stage").length, 8);

  // nothing was released, nothing can be sent
  assert.equal(await prisma.sequence.count({ where: { status: "active" } }), 0);
  assert.equal(await prisma.sequenceStep.count({ where: { status: { in: ["scheduled", "sending", "sent"] } } }), 0);
  const { senders, calls: sent } = spySenders();
  await runSendTick({ senders, now: new Date(Date.now() + 14 * 86_400_000) });
  assert.equal(sent.length, 0);

  // the run, as the app will show it
  const events = await prisma.agentRunEvent.findMany({ where: { runId: s.runId }, orderBy: { seq: "asc" } });
  assert.equal(events.length, toolCalls, "every tool call is one event");
  assert.deepEqual(events.map((e) => e.seq), Array.from({ length: toolCalls }, (_, i) => i + 1));
  assert.ok(events.every((e) => e.ok));
  assert.ok(toolCalls <= 120, `${toolCalls} tool calls: inside the per-minute limit`);

  const run = await s.api("GET", `/runs/${s.runId}?limit=50`);
  assert.equal(run.status, 200);
  assert.equal(run.body.data.run.status, "awaiting_approval");
  assert.deepEqual(run.body.data.run.counts, {
    sequences: 17,
    awaiting_approval: 17,
    active: 0,
    paused: 0,
    steps_sent: 0,
    steps_failed: 0,
    drafts_with_no_call_transcript: 8,
  });
  assert.equal(run.body.data.sequences.items.length, 17);
  const shown = run.body.data.sequences.items.find((i: any) => i.lead.untrusted.name === "Dana Whitfield");
  assert.equal(shown.steps[0].based_on.kind, "transcript");
  assert.match(shown.steps[0].based_on.note, /one-page summary/);
  assert.match(shown.steps[0].body, /one-page summary for the practice owners/);

  // a person releases one of them in the app: only that one starts
  const release = await s.api("PATCH", `/sequences/${shown.sequence_id}`, { status: "active" });
  assert.equal(release.status, 200);
  assert.equal(await prisma.sequence.count({ where: { status: "active" } }), 1);
  assert.equal((await s.api("GET", "/runs")).body.data.items[0].counts.awaiting_approval, 16);

  console.log(`    20 leads -> 17 drafts awaiting approval, 2 left out, 1 had replied; ${toolCalls} tool calls`);
  await s.close();
});

import type { AgentRun, Prisma, SequenceStep } from "@prisma/client";
import type { Actor } from "./actor";
import { computeApprovalHash, currentApprovalHash } from "./approval";
import {
  assertDraft,
  assertEmailAndSmsOnly,
  channelOf,
  type Db,
  findLead,
  findPlaceholder,
  findSequence,
  leadView,
  logHarnessActivity,
  notFound,
  pageOf,
  pagination,
  sequenceView,
  type SequenceWithSteps,
  SKIPPED_ON_REQUEST,
  STEP_STATUS,
  stepTypeFor,
  stepView,
  writtenWithoutTranscript,
} from "./common";
import { isLeadBlocked } from "./do-not-contact";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { pauseSequenceBySystem, syncLeadStatus } from "./pause";
import {
  loadSendWindow,
  nextAllowedTime,
  planSendDates,
  resolveSendWindow,
  startOfLocalDay,
} from "./send-window";
import { outboundMode } from "./switches";
import { requirePermission } from "./permissions";
import { refreshRunAfterApproval } from "./runs/run.service";
import { sendingReady, templateForStage } from "./templates";
import { newestTranscript, transcriptsReadInRun } from "./transcripts";

/**
 * AI harness: sequences and steps.
 *
 * These functions make drafts, change drafts, and mark drafts "awaiting
 * approval". A person releases them in the Touchbase app. Pausing, skipping
 * and stopping only ever reduce sending, so they are always allowed.
 *
 * Two functions start sending, and each works only while its workspace switch
 * is on (Settings → Claude permissions, changed only by a logged-in person):
 * activateSequences ("Claude can activate sequences") and resumeSequence
 * ("Claude can resume sequences").
 */

const DAY_MINUTES = 1440;

const invalid = (message: string, nextStep = "Correct the input and call the tool again.") =>
  new HarnessError("VALIDATION", message, nextStep);

const minutesOf = (delayDays: number): number => Math.round(delayDays * DAY_MINUTES);

const checkDelay = (delayDays: number, stepNumber: number) => {
  if (!Number.isFinite(delayDays) || delayDays < 0 || delayDays > LIMITS.DELAY_MAX_DAYS) {
    throw invalid(`Step ${stepNumber}: delay_days must be between 0 and ${LIMITS.DELAY_MAX_DAYS}.`);
  }
};

const checkTotalLength = (delayMinutes: (number | null)[]) => {
  const total = delayMinutes.reduce<number>((sum, m) => sum + (m ?? 0), 0);
  if (total > LIMITS.SEQUENCE_MAX_DAYS * DAY_MINUTES) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `The delays add up to more than ${LIMITS.SEQUENCE_MAX_DAYS} days.`,
      "Use shorter delays or fewer steps."
    );
  }
};

/**
 * Draft steps need a date in the database, but it means nothing yet: the real
 * dates are worked out when a person approves. This keeps the provisional
 * dates in step order, from now.
 */
const resetProvisionalDates = async (db: Db, sequenceId: string): Promise<void> => {
  const steps = await db.sequenceStep.findMany({
    where: { sequenceId },
    orderBy: { stepOrder: "asc" },
    select: { id: true, delayMinutes: true, scheduledAt: true, status: true },
  });

  let cursor = Date.now();
  for (const step of steps) {
    if (step.status !== STEP_STATUS.PENDING && step.status !== STEP_STATUS.DRAFT) {
      cursor = Math.max(cursor, step.scheduledAt.getTime());
      continue;
    }
    if (step.delayMinutes === null) {
      cursor = Math.max(cursor, step.scheduledAt.getTime()); // an exact date: keep it
      continue;
    }
    cursor += Math.max(step.delayMinutes, 1) * 60_000;
    await db.sequenceStep.update({
      where: { id: step.id },
      data: { scheduledAt: new Date(cursor) },
    });
  }
};

/** An edit takes back a request for approval: the person would be approving something else. */
const withdrawApprovalRequest = async (
  db: Db,
  sequence: { id: string; approvalStatus: string }
): Promise<boolean> => {
  if (sequence.approvalStatus !== "awaiting_approval") return false;
  await db.sequence.update({
    where: { id: sequence.id },
    data: { approvalStatus: "none", approvalRequestedAt: null },
  });
  return true;
};

const syncSequenceShape = async (db: Db, sequenceId: string): Promise<void> => {
  const steps = await db.sequenceStep.findMany({
    where: { sequenceId },
    select: { stepType: true },
  });
  await db.sequence.update({
    where: { id: sequenceId },
    data: {
      totalSteps: steps.length,
      channels: [...new Set(steps.map((s) => channelOf(s.stepType)))],
    },
  });
};

const stepByNumber = (sequence: SequenceWithSteps, stepNumber: number): SequenceStep => {
  const step = sequence.steps.find((s) => s.stepOrder === stepNumber);
  if (!step) throw notFound(`Step ${stepNumber}`);
  return step;
};

// ── reading ──────────────────────────────────────────────────────────

export const listSequences = async (
  actor: Actor,
  db: Db,
  input: {
    status?: string;
    approval_status?: string;
    lead_id?: string;
    run_id?: string;
    page?: number;
    page_size?: number;
  }
): Promise<HarnessOutcome> => {
  const { page, size, skip } = pageOf(input);
  const where: Prisma.SequenceWhereInput = { userId: actor.userId };
  if (input.status) where.status = input.status;
  if (input.approval_status) where.approvalStatus = input.approval_status;
  if (input.lead_id) where.leadId = input.lead_id;
  if (input.run_id) where.runId = input.run_id;

  const [sequences, total] = await Promise.all([
    db.sequence.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: size,
      include: {
        steps: { orderBy: { stepOrder: "asc" } },
        lead: { select: { name: true, company: true, doNotContact: true } },
      },
    }),
    db.sequence.count({ where }),
  ]);

  return {
    result: {
      sequences: sequences.map((sequence) => ({
        ...sequenceView(sequence),
        lead_do_not_contact: sequence.lead.doNotContact,
        untrusted: { lead_name: sequence.lead.name, lead_company: sequence.lead.company },
      })),
      ...pagination(page, size, total),
    },
    summary: `Listed sequences: ${total} found`,
  };
};

export const getSequence = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; include_content?: boolean }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  const withText = input.include_content !== false;

  return {
    result: {
      sequence: sequenceView(sequence),
      lead: leadView(sequence.lead),
      steps: sequence.steps.map((step) => stepView(step, withText)),
    },
    summary: `Read the sequence "${sequence.name}"`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

export const getSequenceActivity = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; page?: number; page_size?: number }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  const { page, size, skip } = pageOf(input);
  const numberOf = new Map(sequence.steps.map((s) => [s.id, s.stepOrder]));

  const [events, total] = await Promise.all([
    db.sequenceActivity.findMany({
      where: { sequenceId: sequence.id },
      orderBy: { createdAt: "desc" },
      skip,
      take: size,
    }),
    db.sequenceActivity.count({ where: { sequenceId: sequence.id } }),
  ]);

  return {
    result: {
      sequence_id: sequence.id,
      events: events.map((event) => ({
        at: event.createdAt.toISOString(),
        event: event.eventType,
        actor: event.actor,
        step_number: event.stepId ? (numberOf.get(event.stepId) ?? null) : null,
        // May repeat text from a mail or SMS provider, or a name: treat as data.
        untrusted_details: event.meta,
      })),
      ...pagination(page, size, total),
    },
    summary: `Read the activity of the sequence "${sequence.name}"`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

// ── creating drafts ──────────────────────────────────────────────────

export const createDraftSequences = async (
  actor: Actor,
  db: Db,
  input: {
    lead_ids: string[];
    name?: string;
    goal?: string;
    tone?: string;
    template_id?: string;
    steps: { step_number: number; channel: string; delay_days: number }[];
  },
  run: AgentRun
): Promise<HarnessOutcome> => {
  const leadIds = [...new Set(input.lead_ids)];
  if (leadIds.length < 1 || leadIds.length > LIMITS.LEADS_PER_BULK_CALL) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `Pass 1 to ${LIMITS.LEADS_PER_BULK_CALL} leads in one call.`,
      `Call the tool again for the next ${LIMITS.LEADS_PER_BULK_CALL} leads.`
    );
  }
  if (input.steps.length < 1 || input.steps.length > LIMITS.STEPS_PER_SEQUENCE) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `A sequence has 1 to ${LIMITS.STEPS_PER_SEQUENCE} steps.`,
      "Use fewer steps."
    );
  }

  const plan = [...input.steps].sort((a, b) => a.step_number - b.step_number);
  plan.forEach((step, index) => {
    if (step.step_number !== index + 1) {
      throw invalid("step_number must count 1, 2, 3 … with no gaps and no repeats.");
    }
    checkDelay(step.delay_days, step.step_number);
  });
  // Refuses WhatsApp and calls by name, before anything is created.
  const stepTypes = plan.map((step) => stepTypeFor(step.channel));
  const delays = plan.map((step) => minutesOf(step.delay_days));
  checkTotalLength(delays);

  if (input.template_id) {
    const owned = await db.promptTemplate.findFirst({
      where: { id: input.template_id, userId: actor.userId },
      select: { id: true },
    });
    if (!owned) throw notFound("Template");
  }

  const alreadyInRun = await db.sequence.count({ where: { runId: run.id } });
  if (alreadyInRun + leadIds.length > LIMITS.SEQUENCES_PER_RUN) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `A run can hold at most ${LIMITS.SEQUENCES_PER_RUN} sequences.`,
      "Finish this run and start a new one for the remaining leads."
    );
  }

  const needsEmail = stepTypes.includes("EMAIL");
  const needsPhone = stepTypes.includes("SMS");
  const results: Record<string, unknown>[] = [];
  const touched: { type: string; id: string; label?: string }[] = [];
  let created = 0;

  for (const leadId of leadIds) {
    const lead = await db.lead.findFirst({ where: { id: leadId, userId: actor.userId, deletedAt: null } });
    if (!lead) {
      results.push({ lead_id: leadId, outcome: "skipped", reason: "lead_not_found" });
      continue;
    }

    const transcript = await newestTranscript(db, actor.userId, lead.id);
    const template = await templateForStage(db, actor.userId, lead.followUpStage);
    const context = {
      transcript_to_read: transcript
        ? {
            transcript_id: transcript.id,
            meeting_date: transcript.meetingDate.toISOString().slice(0, 10),
            chars: transcript.transcript.length,
            untrusted_meeting_title: transcript.meetingTitle,
          }
        : null,
      matched_template: template ? { template_id: template.id, name: template.name } : null,
    };

    // Safe to call twice: one draft per lead per run.
    const existing = await db.sequence.findFirst({
      where: { runId: run.id, leadId: lead.id },
      select: { id: true },
    });
    if (existing) {
      results.push({
        lead_id: lead.id,
        outcome: "already_existed",
        sequence_id: existing.id,
        ...context,
      });
      continue;
    }

    if (await isLeadBlocked(lead, db)) {
      results.push({ lead_id: lead.id, outcome: "skipped", reason: "do_not_contact" });
      continue;
    }
    if (needsEmail && !lead.email) {
      results.push({ lead_id: lead.id, outcome: "skipped", reason: "lead_has_no_email" });
      continue;
    }
    if (needsPhone && !lead.phone) {
      results.push({ lead_id: lead.id, outcome: "skipped", reason: "lead_has_no_phone" });
      continue;
    }

    const name = (input.name?.trim() || `${lead.name} follow-up`).slice(0, LIMITS.SEQUENCE_NAME_MAX);
    const sequence = await db.sequence.create({
      data: {
        userId: actor.userId,
        leadId: lead.id,
        runId: run.id,
        name,
        totalSteps: plan.length,
        status: "draft",
        goal: input.goal?.trim() || null,
        tone: input.tone?.trim() || null,
        promptTemplateId: input.template_id ?? template?.id ?? null,
        channels: [...new Set(plan.map((step) => step.channel.trim().toLowerCase()))],
      },
    });

    let cursor = Date.now();
    for (let index = 0; index < plan.length; index++) {
      cursor += Math.max(delays[index], 1) * 60_000;
      await db.sequenceStep.create({
        data: {
          sequenceId: sequence.id,
          runId: run.id,
          stepOrder: index + 1,
          stepType: stepTypes[index],
          status: STEP_STATUS.PENDING,
          delayMinutes: delays[index],
          scheduledAt: new Date(cursor), // provisional: the real date is set at approval
        },
      });
    }

    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      eventType: "sequence_created",
      meta: { name, totalSteps: plan.length, runId: run.id },
    });

    created++;
    touched.push({ type: "sequence", id: sequence.id, label: name });
    results.push({ lead_id: lead.id, outcome: "created", sequence_id: sequence.id, ...context });
  }

  return {
    result: {
      results,
      created,
      next: "Each draft has steps without text. For every lead: read transcript_to_read with get_lead_transcript (pass run_id), read matched_template with get_template if there is one, then call write_steps.",
    },
    summary: `Created ${created} draft sequence(s) for ${leadIds.length} lead(s)`,
    touched: touched.slice(0, 25),
  };
};

export const updateSequence = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; name?: string; goal?: string | null; tone?: string | null }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  assertDraft(sequence, "update_sequence");
  assertEmailAndSmsOnly(sequence.steps);

  const text = (value: string | null | undefined) => (value ?? "").trim() || null;
  const next = {
    name: input.name !== undefined ? input.name.trim() : sequence.name,
    goal: input.goal !== undefined ? text(input.goal) : sequence.goal,
    tone: input.tone !== undefined ? text(input.tone) : sequence.tone,
  };
  if (!next.name) throw invalid("A sequence needs a name.");

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== sequence[key]
  );

  if (changed.length === 0) {
    return {
      result: { sequence: sequenceView(sequence), changed_fields: [] },
      summary: "The sequence already had these values: nothing was changed",
      touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
    };
  }

  const updated = await db.sequence.update({
    where: { id: sequence.id },
    data: next,
    include: { steps: { orderBy: { stepOrder: "asc" } } },
  });
  const withdrawn = await withdrawApprovalRequest(db, sequence);
  await logHarnessActivity(db, {
    sequenceId: sequence.id,
    eventType: "sequence_edited",
    meta: { fields: changed },
  });

  return {
    result: {
      sequence: sequenceView({ ...updated, approvalStatus: withdrawn ? "none" : updated.approvalStatus }),
      changed_fields: changed,
      approval_request_withdrawn: withdrawn,
    },
    summary: `Updated the sequence "${updated.name}": ${changed.join(", ")}`,
    touched: [{ type: "sequence", id: sequence.id, label: updated.name }],
  };
};

// ── writing the messages ─────────────────────────────────────────────

type StepInput = {
  step_number: number;
  subject?: string | null;
  body: string;
  based_on_transcript_ids?: string[];
  based_on_note?: string | null;
  channel?: string;
  delay_days?: number;
};

export const writeSteps = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; steps: StepInput[] },
  run: AgentRun
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  assertDraft(sequence, "write_steps");
  assertEmailAndSmsOnly(sequence.steps);

  if (input.steps.length < 1 || input.steps.length > LIMITS.STEPS_PER_SEQUENCE) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `Pass 1 to ${LIMITS.STEPS_PER_SEQUENCE} steps in one call.`,
      "Use fewer steps."
    );
  }

  const wanted = [...input.steps].sort((a, b) => a.step_number - b.step_number);
  const numbers = wanted.map((s) => s.step_number);
  if (new Set(numbers).size !== numbers.length) {
    throw invalid("Each step_number may appear only once in a call.");
  }

  const existingCount = sequence.steps.length;
  const newNumbers = numbers.filter((n) => n > existingCount);
  newNumbers.forEach((n, index) => {
    if (n !== existingCount + index + 1) {
      throw invalid(
        `This sequence has ${existingCount} step(s). A new step must be number ${existingCount + index + 1}.`,
        "Use the next free step_number, or read the sequence with get_sequence."
      );
    }
  });
  if (existingCount + newNumbers.length > LIMITS.STEPS_PER_SEQUENCE) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `A sequence has at most ${LIMITS.STEPS_PER_SEQUENCE} steps.`,
      "Use fewer steps."
    );
  }

  // Rule T: read the call before writing.
  const transcripts = await db.leadTranscript.findMany({
    where: { userId: actor.userId, leadId: sequence.leadId },
    orderBy: [{ meetingDate: "desc" }, { createdAt: "desc" }],
  });
  const hasTranscripts = transcripts.length > 0;
  const read = await transcriptsReadInRun(db, run.id, transcripts);

  if (hasTranscripts && !read.get(transcripts[0].id)?.complete) {
    throw new HarnessError(
      "TRANSCRIPT_NOT_READ",
      "This lead's most recent call transcript was not read to the end in this run.",
      "Call get_lead_transcript with this run_id for unread_transcript_id until has_more is false, then call write_steps again.",
      { unread_transcript_id: transcripts[0].id, lead_id: sequence.leadId }
    );
  }

  // Check every step before anything is saved.
  const planned = wanted.map((step) => {
    const current = sequence.steps.find((s) => s.stepOrder === step.step_number) ?? null;
    const n = step.step_number;

    if (!current && !step.channel) {
      throw invalid(`Step ${n} is new: pass its channel ("email" or "sms").`);
    }
    if (!current && step.delay_days === undefined) {
      throw invalid(`Step ${n} is new: pass delay_days (days after the step before it).`);
    }
    const stepType = step.channel ? stepTypeFor(step.channel) : (current as SequenceStep).stepType;
    if (step.delay_days !== undefined) checkDelay(step.delay_days, n);
    const delayMinutes =
      step.delay_days !== undefined ? minutesOf(step.delay_days) : (current?.delayMinutes ?? null);

    const body = step.body.trim();
    if (!body) throw invalid(`Step ${n} has no text.`, "Write the message and call write_steps again.");

    let subject: string | null = null;
    if (stepType === "EMAIL") {
      subject = (step.subject ?? current?.subject ?? "").trim() || null;
      if (!subject) throw invalid(`Step ${n} is an email and needs a subject.`);
      if (subject.length > LIMITS.EMAIL_SUBJECT_MAX) {
        throw new HarnessError(
          "LIMIT_EXCEEDED",
          `Step ${n}: the subject is ${subject.length} characters; the limit is ${LIMITS.EMAIL_SUBJECT_MAX}.`,
          "Shorten the subject."
        );
      }
    }
    const bodyMax = stepType === "EMAIL" ? LIMITS.EMAIL_BODY_MAX : LIMITS.SMS_BODY_MAX;
    if (body.length > bodyMax) {
      throw new HarnessError(
        "LIMIT_EXCEEDED",
        `Step ${n}: the ${stepType === "EMAIL" ? "email" : "SMS"} text is ${body.length} characters; the limit is ${bodyMax}.`,
        "Shorten the message."
      );
    }

    for (const [where, text] of [["subject", subject], ["body", body]] as const) {
      const placeholder = findPlaceholder(text);
      if (placeholder) {
        throw new HarnessError(
          "PLACEHOLDER_LEFT",
          `Step ${n} ${where} still contains ${placeholder}.`,
          "Write the real words in its place (for example the lead's real name) and call write_steps again. Nothing fills placeholders when a message is sent."
        );
      }
    }

    const note = (step.based_on_note ?? "").trim() || null;
    if (note && note.length > LIMITS.BASED_ON_NOTE_MAX) {
      throw new HarnessError(
        "LIMIT_EXCEEDED",
        `Step ${n}: based_on_note is ${note.length} characters; the limit is ${LIMITS.BASED_ON_NOTE_MAX}.`,
        "Keep it to one short line."
      );
    }

    const ids = [...new Set(step.based_on_transcript_ids ?? [])];
    if (ids.length > LIMITS.BASED_ON_TRANSCRIPTS_MAX) {
      throw new HarnessError(
        "LIMIT_EXCEEDED",
        `Step ${n}: name at most ${LIMITS.BASED_ON_TRANSCRIPTS_MAX} transcripts.`,
        "Keep the ones you used most."
      );
    }
    for (const id of ids) {
      if (!read.get(id)?.touched) {
        throw invalid(
          `Step ${n}: based_on_transcript_ids names a transcript that is not this lead's, or that was not read in this run.`,
          "Name only transcripts of this lead that you read in this run with get_lead_transcript."
        );
      }
    }

    const basis = !hasTranscripts ? "notes_and_stage" : ids.length > 0 ? "transcript" : "not_stated";

    return { n, current, stepType, delayMinutes, subject, body, note, ids, basis };
  });

  const finalDelays = [
    ...sequence.steps.map((s) => planned.find((p) => p.n === s.stepOrder)?.delayMinutes ?? s.delayMinutes),
    ...planned.filter((p) => !p.current).map((p) => p.delayMinutes),
  ];
  checkTotalLength(finalDelays);

  const warnings: string[] = [];
  const stepResults: Record<string, unknown>[] = [];
  let anyChange = false;
  let timingChanged = false;

  for (const p of planned) {
    const basedOn = { kind: p.basis, transcript_ids: p.ids, note: p.note };

    if (p.basis === "not_stated") {
      warnings.push(
        `Step ${p.n}: this lead has a call transcript but the step names none in based_on_transcript_ids. It is saved as "not stated".`
      );
    }
    if (p.stepType === "SMS" && p.body.length > LIMITS.SMS_SINGLE_PART) {
      warnings.push(
        `Step ${p.n}: the SMS is ${p.body.length} characters, so it is sent as more than one part.`
      );
    }

    const data = {
      stepType: p.stepType,
      subject: p.subject,
      content: p.body,
      delayMinutes: p.delayMinutes,
      basis: p.basis,
      basedOnTranscriptIds: p.ids,
      basedOnNote: p.note,
      status: STEP_STATUS.DRAFT,
    };

    if (!p.current) {
      const createdStep = await db.sequenceStep.create({
        data: {
          ...data,
          sequenceId: sequence.id,
          runId: run.id,
          stepOrder: p.n,
          scheduledAt: new Date(Date.now() + p.n * 60_000), // provisional, reset below
        },
      });
      await logHarnessActivity(db, {
        sequenceId: sequence.id,
        stepId: createdStep.id,
        eventType: "step_edited",
        meta: { stepOrder: p.n, stepType: p.stepType, created: true },
      });
      stepResults.push({ step_number: p.n, outcome: "created", based_on: basedOn });
      anyChange = true;
      timingChanged = true;
      continue;
    }

    const c = p.current;
    const currentIds = Array.isArray(c.basedOnTranscriptIds) ? c.basedOnTranscriptIds : [];
    const same =
      c.stepType === data.stepType &&
      c.subject === data.subject &&
      c.content === data.content &&
      c.delayMinutes === data.delayMinutes &&
      c.basis === data.basis &&
      c.basedOnNote === data.basedOnNote &&
      c.status === STEP_STATUS.DRAFT &&
      JSON.stringify(currentIds) === JSON.stringify(p.ids);

    if (same) {
      stepResults.push({ step_number: p.n, outcome: "unchanged", based_on: basedOn });
      continue;
    }

    if (c.delayMinutes !== data.delayMinutes) timingChanged = true;
    await db.sequenceStep.update({ where: { id: c.id }, data });
    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      stepId: c.id,
      eventType: "step_edited",
      meta: { stepOrder: p.n, stepType: p.stepType },
    });
    stepResults.push({ step_number: p.n, outcome: "updated", based_on: basedOn });
    anyChange = true;
  }

  let withdrawn = false;
  if (anyChange) {
    await syncSequenceShape(db, sequence.id);
    if (timingChanged) await resetProvisionalDates(db, sequence.id);
    withdrawn = await withdrawApprovalRequest(db, sequence);
  }

  const after = await db.sequenceStep.findMany({
    where: { sequenceId: sequence.id },
    select: { basis: true, status: true },
  });
  const withoutText = after.filter((s) => s.status === STEP_STATUS.PENDING).length;

  return {
    result: {
      sequence_id: sequence.id,
      steps: stepResults,
      no_call_transcript: writtenWithoutTranscript(after),
      steps_still_without_text: withoutText,
      approval_request_withdrawn: withdrawn,
      warnings,
      ...(withdrawn
        ? { note: "The request for approval was withdrawn because the draft changed. Call request_approval again when it is ready." }
        : {}),
    },
    summary: anyChange
      ? `Wrote ${stepResults.filter((s) => s.outcome !== "unchanged").length} step(s) for ${sequence.lead.name}`
      : `The steps for ${sequence.lead.name} already had this text: nothing was changed`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

// ── timing and order ─────────────────────────────────────────────────

export const rescheduleStep = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; step_number: number; delay_days?: number; send_at?: string }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  assertDraft(sequence, "reschedule_step");
  assertEmailAndSmsOnly(sequence.steps);
  const step = stepByNumber(sequence, input.step_number);

  if ((input.delay_days === undefined) === (input.send_at === undefined)) {
    throw invalid("Pass exactly one of delay_days or send_at.");
  }

  const warnings: string[] = [];
  let moved = false;
  let data: { delayMinutes: number | null; scheduledAt?: Date };

  if (input.delay_days !== undefined) {
    checkDelay(input.delay_days, step.stepOrder);
    data = { delayMinutes: minutesOf(input.delay_days) };
    checkTotalLength(
      sequence.steps.map((s) => (s.id === step.id ? data.delayMinutes : s.delayMinutes))
    );
  } else {
    const wantedAt = new Date(input.send_at as string);
    const latest = Date.now() + LIMITS.SEQUENCE_MAX_DAYS * 86_400_000;
    if (Number.isNaN(wantedAt.getTime()) || wantedAt.getTime() <= Date.now() || wantedAt.getTime() > latest) {
      throw invalid(
        `send_at must be a date and time in the future, at most ${LIMITS.SEQUENCE_MAX_DAYS} days from now.`,
        "Pass an ISO date and time, for example 2026-12-01T10:00:00Z."
      );
    }

    let at = wantedAt;
    const sendWindow = await loadSendWindow(actor.userId, db);
    if (sendWindow.ok) {
      at = nextAllowedTime(wantedAt, sendWindow.window);
      moved = at.getTime() !== wantedAt.getTime();
    } else {
      warnings.push(`${sendWindow.message} The date could not be checked against the send window.`);
    }
    data = { delayMinutes: null, scheduledAt: at };
  }

  const unchanged =
    step.delayMinutes === data.delayMinutes &&
    (data.scheduledAt === undefined || step.scheduledAt.getTime() === data.scheduledAt.getTime());

  let withdrawn = false;
  if (!unchanged) {
    await db.sequenceStep.update({ where: { id: step.id }, data });
    await resetProvisionalDates(db, sequence.id);
    withdrawn = await withdrawApprovalRequest(db, sequence);
    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      stepId: step.id,
      eventType: "step_rescheduled",
      meta: {
        stepOrder: step.stepOrder,
        delayDays: input.delay_days ?? null,
        sendAt: data.scheduledAt?.toISOString() ?? null,
      },
    });
  }

  return {
    result: {
      sequence_id: sequence.id,
      step_number: step.stepOrder,
      delay_days: input.delay_days ?? null,
      send_at: data.scheduledAt?.toISOString() ?? null,
      moved_into_send_window: moved,
      changed: !unchanged,
      approval_request_withdrawn: withdrawn,
      warnings,
      note: "The real send date is worked out when a person approves, inside the user's send window.",
    },
    summary: unchanged
      ? `Step ${step.stepOrder} already had this timing: nothing was changed`
      : `Changed when step ${step.stepOrder} of "${sequence.name}" goes out`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

export const reorderSteps = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; step_ids_in_new_order: string[] }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  assertDraft(sequence, "reorder_steps");
  assertEmailAndSmsOnly(sequence.steps);

  // The order is given by step ids, not numbers: a number changes when the
  // order changes, so a repeated call would undo itself. An id does not.
  const order = input.step_ids_in_new_order;
  const byId = new Map(sequence.steps.map((s) => [s.id, s]));
  if (
    order.length !== sequence.steps.length ||
    new Set(order).size !== order.length ||
    order.some((id) => !byId.has(id))
  ) {
    throw invalid(
      `step_ids_in_new_order must list the step_id of each of the ${sequence.steps.length} steps exactly once.`,
      "Read the sequence with get_sequence and pass all its step_id values in the new order."
    );
  }

  const unchanged = order.every((id, index) => (byId.get(id) as SequenceStep).stepOrder === index + 1);
  let withdrawn = false;

  if (!unchanged) {
    // Timing belongs to the position ("N days after the step before"), text to the step.
    const slots = sequence.steps.map((s) => ({
      delayMinutes: s.delayMinutes,
      scheduledAt: s.scheduledAt,
    }));

    await db.$executeRaw`
      UPDATE sequence_steps SET "stepOrder" = -"stepOrder" WHERE "sequenceId" = ${sequence.id}
    `;
    for (let index = 0; index < order.length; index++) {
      await db.sequenceStep.update({
        where: { id: order[index] },
        data: { stepOrder: index + 1, ...slots[index] },
      });
    }

    withdrawn = await withdrawApprovalRequest(db, sequence);
    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      eventType: "steps_reordered",
      meta: { order },
    });
  }

  const steps = await db.sequenceStep.findMany({
    where: { sequenceId: sequence.id },
    orderBy: { stepOrder: "asc" },
  });

  return {
    result: {
      sequence_id: sequence.id,
      changed: !unchanged,
      approval_request_withdrawn: withdrawn,
      steps: steps.map((step) => stepView(step, false)),
    },
    summary: unchanged
      ? "The steps were already in this order: nothing was changed"
      : `Changed the order of the steps of "${sequence.name}"`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

export const removeStep = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; step_number: number; step_id: string }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  assertDraft(sequence, "remove_step");
  assertEmailAndSmsOnly(sequence.steps);

  const view = (steps: SequenceStep[]) => steps.map((step) => stepView(step, false));
  const step = sequence.steps.find((s) => s.id === input.step_id);

  // Safe to call twice: the step is named by its id, so a repeat finds nothing to remove.
  if (!step) {
    return {
      result: {
        sequence_id: sequence.id,
        removed: false,
        already_removed: true,
        total_steps: sequence.steps.length,
        steps: view(sequence.steps),
      },
      summary: "That step was already removed: nothing was changed",
      touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
    };
  }

  if (step.stepOrder !== input.step_number) {
    throw new HarnessError(
      "CONFLICT",
      `step_id belongs to step ${step.stepOrder}, not step ${input.step_number}. The numbering has changed.`,
      "Read the sequence again with get_sequence, then pass the step_id and step_number that belong together."
    );
  }
  if (sequence.steps.length === 1) {
    throw invalid(
      "This is the only step. A sequence needs at least one.",
      "Use stop_sequence to end the whole sequence instead."
    );
  }

  await db.sequenceStep.delete({ where: { id: step.id } });
  for (const later of sequence.steps.filter((s) => s.stepOrder > step.stepOrder)) {
    await db.sequenceStep.update({
      where: { id: later.id },
      data: { stepOrder: later.stepOrder - 1 },
    });
  }
  await syncSequenceShape(db, sequence.id);
  await resetProvisionalDates(db, sequence.id);
  const withdrawn = await withdrawApprovalRequest(db, sequence);
  await logHarnessActivity(db, {
    sequenceId: sequence.id,
    eventType: "step_removed",
    meta: { stepOrder: step.stepOrder, stepType: step.stepType },
  });

  const steps = await db.sequenceStep.findMany({
    where: { sequenceId: sequence.id },
    orderBy: { stepOrder: "asc" },
  });

  return {
    result: {
      sequence_id: sequence.id,
      removed: true,
      already_removed: false,
      total_steps: steps.length,
      approval_request_withdrawn: withdrawn,
      steps: view(steps),
    },
    summary: `Removed step ${step.stepOrder} from "${sequence.name}"`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

const UNSENT = new Set<string>([STEP_STATUS.PENDING, STEP_STATUS.DRAFT, STEP_STATUS.SCHEDULED]);
const IN_FLIGHT = [STEP_STATUS.SCHEDULED, STEP_STATUS.SENDING, STEP_STATUS.CALLING];

export const skipStep = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; step_number: number; reason?: string }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  const step = stepByNumber(sequence, input.step_number);
  const touched = [{ type: "sequence", id: sequence.id, label: sequence.name }];

  if (sequence.status === "draft") {
    throw invalid(
      "This sequence is still a draft. A step of a draft is removed, not skipped.",
      "Use remove_step for a draft. skip_step is for a sequence a person already released."
    );
  }

  if (step.status === STEP_STATUS.SKIPPED) {
    return {
      result: { sequence_id: sequence.id, step: stepView(step, false), was_already_skipped: true },
      summary: `Step ${step.stepOrder} was already skipped: nothing was changed`,
      touched,
    };
  }
  if (!UNSENT.has(step.status)) {
    throw new HarnessError(
      "CONFLICT",
      `Step ${step.stepOrder} is "${step.status}". Only a step that has not gone out can be skipped.`,
      "Nothing to do for this step."
    );
  }

  const reason = (input.reason ?? "").trim().slice(0, LIMITS.REASON_MAX);
  const updated = await db.sequenceStep.update({
    where: { id: step.id },
    data: {
      status: STEP_STATUS.SKIPPED,
      sendLog: reason ? `${SKIPPED_ON_REQUEST}: ${reason}` : SKIPPED_ON_REQUEST,
    },
  });
  await logHarnessActivity(db, {
    sequenceId: sequence.id,
    stepId: step.id,
    eventType: "step_skipped",
    meta: { stepOrder: step.stepOrder, stepType: step.stepType, reason: reason || null },
  });

  // A running sequence with nothing left to send is complete.
  let completed = false;
  if (sequence.status === "active") {
    const left = await db.sequenceStep.count({
      where: { sequenceId: sequence.id, status: { in: IN_FLIGHT } },
    });
    if (left === 0) {
      await db.sequence.update({ where: { id: sequence.id }, data: { status: "completed" } });
      await syncLeadStatus(sequence.leadId, db);
      completed = true;
    }
  }

  return {
    result: {
      sequence_id: sequence.id,
      step: stepView(updated, false),
      was_already_skipped: false,
      sequence_completed: completed,
    },
    summary: `Skipped step ${step.stepOrder} of "${sequence.name}"`,
    touched,
  };
};

// ── asking a person to approve ───────────────────────────────────────

/** Everything that would stop a person from releasing this draft, in plain words. */
const problemsOf = async (db: Db, sequence: SequenceWithSteps): Promise<string[]> => {
  const problems: string[] = [];
  const steps = sequence.steps;

  if (sequence.status !== "draft") {
    return [`The sequence is "${sequence.status}", not a draft.`];
  }
  if (steps.length === 0) problems.push("The sequence has no steps.");
  if (steps.length > LIMITS.STEPS_PER_SEQUENCE) {
    problems.push(`The sequence has more than ${LIMITS.STEPS_PER_SEQUENCE} steps.`);
  }

  for (const step of steps) {
    const n = step.stepOrder;
    if (step.stepType !== "EMAIL" && step.stepType !== "SMS") {
      problems.push(`Step ${n} is a ${channelOf(step.stepType)} step. Only email and SMS can be approved through Claude.`);
      continue;
    }
    const body = (step.content ?? "").trim();
    if (!body || step.status === STEP_STATUS.PENDING) {
      problems.push(`Step ${n} has no text.`);
      continue;
    }
    if (step.stepType === "EMAIL") {
      if (!(step.subject ?? "").trim()) problems.push(`Step ${n} is an email without a subject.`);
      if ((step.subject ?? "").length > LIMITS.EMAIL_SUBJECT_MAX) problems.push(`Step ${n}: the subject is too long.`);
      if (body.length > LIMITS.EMAIL_BODY_MAX) problems.push(`Step ${n}: the email text is too long.`);
      if (!sequence.lead.email) problems.push(`Step ${n} is an email but the lead has no email address.`);
    } else {
      if (body.length > LIMITS.SMS_BODY_MAX) problems.push(`Step ${n}: the SMS text is too long.`);
      if (!sequence.lead.phone) problems.push(`Step ${n} is an SMS but the lead has no phone number.`);
    }
    const placeholder = findPlaceholder(step.subject) ?? findPlaceholder(step.content);
    if (placeholder) problems.push(`Step ${n} still contains ${placeholder}.`);
  }

  const totalMinutes = steps.reduce((sum, s) => sum + (s.delayMinutes ?? 0), 0);
  if (totalMinutes > LIMITS.SEQUENCE_MAX_DAYS * DAY_MINUTES) {
    problems.push(`The delays add up to more than ${LIMITS.SEQUENCE_MAX_DAYS} days.`);
  }
  if (await isLeadBlocked(sequence.lead, db)) {
    problems.push("The lead is marked do-not-contact.");
  }
  if (sequence.lead.deletedAt) problems.push("The lead was deleted.");

  return problems;
};

export const requestApproval = async (
  actor: Actor,
  db: Db,
  input: { sequence_ids: string[]; note?: string }
): Promise<HarnessOutcome> => {
  const ids = [...new Set(input.sequence_ids)];
  if (ids.length < 1 || ids.length > LIMITS.LEADS_PER_BULK_CALL) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `Pass 1 to ${LIMITS.LEADS_PER_BULK_CALL} sequences in one call.`,
      "Call the tool again for the rest."
    );
  }

  const results: Record<string, unknown>[] = [];
  const touched: { type: string; id: string; label?: string }[] = [];
  let accepted = 0;

  for (const id of ids) {
    const sequence = await db.sequence.findFirst({
      where: { id, userId: actor.userId },
      include: { steps: { orderBy: { stepOrder: "asc" } }, lead: true },
    });
    if (!sequence) {
      results.push({ sequence_id: id, outcome: "rejected", problems: ["Sequence not found."] });
      continue;
    }

    const problems = await problemsOf(db, sequence);
    if (problems.length > 0) {
      // A draft that no longer passes is not left "awaiting approval".
      await withdrawApprovalRequest(db, sequence);
      results.push({ sequence_id: id, outcome: "rejected", problems });
      continue;
    }

    touched.push({ type: "sequence", id: sequence.id, label: sequence.name });
    if (sequence.approvalStatus === "awaiting_approval") {
      results.push({ sequence_id: id, outcome: "already_awaiting" });
      accepted++;
      continue;
    }

    await db.sequence.update({
      where: { id: sequence.id },
      data: { approvalStatus: "awaiting_approval", approvalRequestedAt: new Date() },
    });
    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      eventType: "approval_requested",
      meta: { note: (input.note ?? "").trim().slice(0, LIMITS.REASON_MAX) || null },
    });
    results.push({ sequence_id: id, outcome: "awaiting_approval" });
    accepted++;
  }

  const warnings: string[] = [];
  const sendWindow = await loadSendWindow(actor.userId, db);
  if (!sendWindow.ok) {
    warnings.push(
      `${sendWindow.message} The drafts are saved and waiting, but the person cannot approve them until this is done. Tell the user.`
    );
  }

  // Approved messages on a channel that is not set up would fail at send time.
  if (accepted > 0) {
    const acceptedIds = results
      .filter((r) => r.outcome === "awaiting_approval" || r.outcome === "already_awaiting")
      .map((r) => r.sequence_id as string);
    const channels = await db.sequenceStep.findMany({
      where: { sequenceId: { in: acceptedIds } },
      distinct: ["stepType"],
      select: { stepType: true },
    });
    const ready = sendingReady(await db.userSettings.findUnique({ where: { userId: actor.userId } }));
    const missing = [
      ...(channels.some((c) => c.stepType === "EMAIL") && !ready.email ? ["email"] : []),
      ...(channels.some((c) => c.stepType === "SMS") && !ready.sms ? ["SMS"] : []),
    ];
    if (missing.length > 0) {
      warnings.push(
        `${missing.join(" and ")} sending is not set up in Touchbase Settings. The drafts are waiting for approval, but once approved those messages would fail. Tell the user to set it up before approving.`
      );
    }
  }

  return {
    result: {
      results,
      awaiting_approval: accepted,
      rejected: results.filter((r) => r.outcome === "rejected").length,
      warnings,
      review_path: null,
      what_happens_next:
        "Nothing is sent yet. A person must open each draft in the Touchbase app and activate it. Tell the user the drafts are ready for their review.",
    },
    summary: `Asked for approval of ${accepted} draft(s)`,
    touched: touched.slice(0, 25),
  };
};

// ── activate (only while "Claude can activate sequences" is on) ──────

export const activateSequences = async (
  actor: Actor,
  db: Db,
  input: { sequence_ids: string[] }
): Promise<HarnessOutcome> => {
  const settings = await requirePermission(db, actor.userId, "activate");

  const ids = [...new Set(input.sequence_ids)];
  if (ids.length < 1 || ids.length > LIMITS.LEADS_PER_BULK_CALL) {
    throw new HarnessError(
      "LIMIT_EXCEEDED",
      `Pass 1 to ${LIMITS.LEADS_PER_BULK_CALL} sequences in one call.`,
      "Call the tool again for the rest."
    );
  }

  // No timezone, no activation: messages go out only inside the send window.
  const sendWindow = resolveSendWindow(settings);
  if (!sendWindow.ok) {
    throw new HarnessError(
      "VALIDATION",
      sendWindow.message,
      "Nothing was activated. Tell the user to set their timezone in Touchbase Settings (or, if they ask you to, set it with update_workspace_settings), then try again."
    );
  }
  const window = sendWindow.window;
  const ready = sendingReady(settings);

  const now = new Date();
  const cap = settings.claudeDailyActivationCap;
  let activatedToday = await db.sequence.count({
    where: {
      userId: actor.userId,
      approvedByActor: "claude",
      approvedAt: { gte: startOfLocalDay(now, window.timeZone) },
    },
  });

  const results: Record<string, unknown>[] = [];
  const touched: { type: string; id: string; label?: string }[] = [];
  let activated = 0;

  for (const id of ids) {
    const sequence = await db.sequence.findFirst({
      where: { id, userId: actor.userId },
      include: { steps: { orderBy: { stepOrder: "asc" } }, lead: true },
    });
    if (!sequence) {
      results.push({ sequence_id: id, outcome: "rejected", problems: ["Sequence not found."] });
      continue;
    }
    if (sequence.status === "active") {
      results.push({ sequence_id: id, outcome: "already_active" });
      continue;
    }
    if (sequence.status === "draft" && sequence.approvalStatus !== "awaiting_approval") {
      results.push({
        sequence_id: id,
        outcome: "rejected",
        problems: ["This draft has not passed request_approval. Call request_approval first."],
      });
      continue;
    }

    // The same checks as request_approval, run again now, plus sending setup.
    const problems = await problemsOf(db, sequence);
    if (sequence.steps.some((s) => s.stepType === "EMAIL") && !ready.email) {
      problems.push("Email sending is not set up in Touchbase Settings.");
    }
    if (sequence.steps.some((s) => s.stepType === "SMS") && !ready.sms) {
      problems.push("SMS sending is not set up in Touchbase Settings.");
    }
    const otherActive = await db.sequence.count({
      where: { leadId: sequence.leadId, status: "active", id: { not: sequence.id } },
    });
    if (otherActive > 0) problems.push("This lead already has another running sequence.");
    if (problems.length > 0) {
      results.push({ sequence_id: id, outcome: "rejected", problems });
      continue;
    }

    if (activatedToday >= cap) {
      results.push({
        sequence_id: id,
        outcome: "rejected",
        problems: [
          `The daily limit of ${cap} sequences activated by Claude is reached. A person can still activate it in the Touchbase app.`,
        ],
      });
      continue;
    }

    // The same release as a person's click in the app: real dates inside the
    // send window, steps scheduled, and a record of exactly what was released.
    const planned = planSendDates(sequence.steps, window, now);
    for (const [stepId, scheduledAt] of planned) {
      await db.sequenceStep.update({ where: { id: stepId }, data: { scheduledAt } });
    }
    await db.sequenceStep.updateMany({
      where: { sequenceId: sequence.id, status: STEP_STATUS.DRAFT },
      data: { status: STEP_STATUS.SCHEDULED },
    });
    await db.sequence.update({
      where: { id: sequence.id },
      data: {
        status: "active",
        approvalStatus: "approved",
        approvedAt: now,
        approvedByUserId: actor.userId,
        approvedByActor: "claude",
        approvedContentHash: computeApprovalHash({
          leadEmail: sequence.lead.email,
          leadPhone: sequence.lead.phone,
          steps: sequence.steps,
        }),
        pausedReason: null,
        pausedAt: null,
      },
    });
    await syncLeadStatus(sequence.leadId, db);
    if (sequence.runId) await refreshRunAfterApproval(sequence.runId, db);
    await logHarnessActivity(db, {
      sequenceId: sequence.id,
      eventType: "sequence_status_changed",
      meta: { from: "draft", to: "active", by: "claude" },
    });

    const first = [...planned.values()].sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    results.push({
      sequence_id: id,
      outcome: "activated",
      first_send_at: first ? first.toISOString() : null,
    });
    touched.push({ type: "sequence", id: sequence.id, label: sequence.name });
    activated++;
    activatedToday++;
  }

  return {
    result: {
      results,
      activated,
      already_active: results.filter((r) => r.outcome === "already_active").length,
      rejected: results.filter((r) => r.outcome === "rejected").length,
      activations_left_today: Math.max(0, cap - activatedToday),
      outbound_mode: outboundMode(),
      what_happens_next:
        outboundMode() === "mock"
          ? "The sequences are running. This server is in mock mode: messages are recorded, not really sent."
          : "The sequences are running. Messages go out inside the send window. Tell the user what was activated.",
    },
    summary: `Activated ${activated} sequence(s)`,
    touched: touched.slice(0, 25),
  };
};

// ── pause, resume, stop ──────────────────────────────────────────────

export const pauseSequence = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; reason?: string }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  const touched = [{ type: "sequence", id: sequence.id, label: sequence.name }];

  if (sequence.status === "paused") {
    return {
      result: {
        sequence_id: sequence.id,
        status: "paused",
        paused_reason: sequence.pausedReason,
        was_already_paused: true,
      },
      summary: `"${sequence.name}" was already paused: nothing was changed`,
      touched,
    };
  }
  if (sequence.status !== "active") {
    throw new HarnessError(
      "CONFLICT",
      `This sequence is "${sequence.status}". Only a running sequence can be paused.`,
      sequence.status === "draft"
        ? "A draft sends nothing, so there is nothing to pause."
        : "Nothing to do for this sequence."
    );
  }

  const note = (input.reason ?? "").trim().slice(0, LIMITS.REASON_MAX) || null;
  await pauseSequenceBySystem(sequence.id, "paused_by_claude", db, "claude", note);

  return {
    result: {
      sequence_id: sequence.id,
      status: "paused",
      paused_reason: "paused_by_claude",
      was_already_paused: false,
      note: "No more messages go out. Only a person can resume it, in the Touchbase app.",
    },
    summary: `Paused "${sequence.name}"`,
    touched,
  };
};

export const resumeSequence = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string }
): Promise<HarnessOutcome> => {
  // Resuming starts sending again: only while the workspace switch is on.
  await requirePermission(db, actor.userId, "resume");
  const sequence = await findSequence(db, actor.userId, input.sequence_id);

  const humanOnly = (message: string) =>
    new HarnessError(
      "HUMAN_ONLY",
      message,
      "Tell the user to resume this sequence in the Touchbase app."
    );

  if (sequence.status === "active") {
    return {
      result: { sequence_id: sequence.id, status: "active", was_already_active: true },
      summary: `"${sequence.name}" was already running: nothing was changed`,
      touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
    };
  }
  if (sequence.status !== "paused") {
    throw humanOnly(`This sequence is "${sequence.status}". It was never released, or it has ended.`);
  }
  if (sequence.lead.deletedAt) throw humanOnly("The lead of this sequence was deleted.");
  // Only a pause made by Claude or by the user's own pause button. A pause for
  // a reply, do-not-contact or a change after approval needs a person's eyes.
  if (sequence.pausedReason !== "paused_by_claude" && sequence.pausedReason !== "paused_by_user") {
    throw humanOnly(`This sequence was paused for the reason "${sequence.pausedReason}".`);
  }
  const approved =
    sequence.approvalStatus === "approved" &&
    Boolean(sequence.approvedByUserId) &&
    sequence.approvedContentHash === (await currentApprovalHash(sequence.id, db));
  if (!approved) {
    throw humanOnly("The messages or the recipient changed since a person approved this sequence.");
  }
  if (await isLeadBlocked(sequence.lead, db)) {
    throw new HarnessError("DO_NOT_CONTACT", "The lead is marked do-not-contact.", "Leave this sequence paused and tell the user.");
  }
  const otherActive = await db.sequence.count({
    where: { leadId: sequence.leadId, status: "active", id: { not: sequence.id } },
  });
  if (otherActive > 0) {
    throw new HarnessError("CONFLICT", "This lead already has another running sequence.", "Pause or stop the other one first, or tell the user.");
  }

  await db.sequence.update({
    where: { id: sequence.id },
    data: { status: "active", pausedReason: null, pausedAt: null },
  });
  await syncLeadStatus(sequence.leadId, db);
  await logHarnessActivity(db, {
    sequenceId: sequence.id,
    eventType: "sequence_status_changed",
    meta: { from: "paused", to: "active", by: "claude" },
  });

  return {
    result: { sequence_id: sequence.id, status: "active", was_already_active: false },
    summary: `Resumed "${sequence.name}"`,
    touched: [{ type: "sequence", id: sequence.id, label: sequence.name }],
  };
};

export const stopSequence = async (
  actor: Actor,
  db: Db,
  input: { sequence_id: string; reason?: string }
): Promise<HarnessOutcome> => {
  const sequence = await findSequence(db, actor.userId, input.sequence_id);
  const touched = [{ type: "sequence", id: sequence.id, label: sequence.name }];

  if (sequence.status === "cancelled" || sequence.status === "completed") {
    return {
      result: {
        sequence_id: sequence.id,
        status: sequence.status,
        steps_skipped: 0,
        was_already_ended: true,
      },
      summary: `"${sequence.name}" had already ended: nothing was changed`,
      touched,
    };
  }

  const skipped = await db.sequenceStep.updateMany({
    where: {
      sequenceId: sequence.id,
      status: {
        in: [
          STEP_STATUS.PENDING,
          STEP_STATUS.DRAFT,
          STEP_STATUS.SCHEDULED,
          STEP_STATUS.SENDING,
          STEP_STATUS.CALLING,
        ],
      },
    },
    data: { status: STEP_STATUS.SKIPPED },
  });
  await db.sequence.update({
    where: { id: sequence.id },
    data: { status: "cancelled", approvalStatus: "none", approvalRequestedAt: null },
  });
  await syncLeadStatus(sequence.leadId, db);
  await logHarnessActivity(db, {
    sequenceId: sequence.id,
    eventType: "sequence_status_changed",
    meta: {
      from: sequence.status,
      to: "cancelled",
      reason: (input.reason ?? "").trim().slice(0, LIMITS.REASON_MAX) || null,
    },
  });

  return {
    result: {
      sequence_id: sequence.id,
      status: "cancelled",
      steps_skipped: skipped.count,
      was_already_ended: false,
      note: "This cannot be undone through Claude. Messages that were already sent stay sent.",
    },
    summary: `Stopped "${sequence.name}"`,
    touched,
  };
};

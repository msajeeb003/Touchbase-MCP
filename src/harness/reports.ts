import type { Actor } from "./actor";
import { channelOf, type Db, findLead, pageOf, pagination } from "./common";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { outboundMode, replyTrackingEnabled } from "./switches";

/**
 * AI harness: numbers and recent activity. Read only.
 * Email and SMS only: WhatsApp and call figures are left out.
 */

const DAY_MS = 86_400_000;
const CHANNELS = ["EMAIL", "SMS"];

export const getDashboard = async (
  actor: Actor,
  db: Db,
  input: { days?: number; upcoming_days?: number }
): Promise<HarnessOutcome> => {
  const days = Math.min(365, Math.max(1, Math.floor(input.days ?? 30)));
  const upcomingDays = Math.min(30, Math.max(1, Math.floor(input.upcoming_days ?? 7)));
  const userId = actor.userId;
  const since = new Date(Date.now() - days * DAY_MS);
  const until = new Date(Date.now() + upcomingDays * DAY_MS);
  const mine = { sequence: { userId } };

  const [sent, failed, replies, leadsByStage, leadTotals, sequences, awaiting, upcoming] =
    await Promise.all([
      db.sequenceStep.groupBy({
        by: ["stepType", "deliveryMode"],
        where: { ...mine, stepType: { in: CHANNELS }, status: "sent", sentAt: { gte: since } },
        _count: { _all: true },
      }),
      db.sequenceStep.groupBy({
        by: ["stepType"],
        where: { ...mine, stepType: { in: CHANNELS }, status: "failed", updatedAt: { gte: since } },
        _count: { _all: true },
      }),
      db.leadInboundEmail.groupBy({
        by: ["channel"],
        where: { userId, receivedAt: { gte: since } },
        _count: { _all: true },
      }),
      db.lead.groupBy({ by: ["followUpStage"], where: { userId, deletedAt: null }, _count: { _all: true } }),
      db.lead.groupBy({ by: ["doNotContact"], where: { userId, deletedAt: null }, _count: { _all: true } }),
      db.sequence.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
      db.sequence.count({ where: { userId, status: "draft", approvalStatus: "awaiting_approval" } }),
      db.sequenceStep.findMany({
        where: {
          sequence: { userId, status: "active" },
          stepType: { in: CHANNELS },
          status: "scheduled",
          scheduledAt: { lte: until },
        },
        orderBy: { scheduledAt: "asc" },
        take: 20,
        select: {
          stepOrder: true,
          stepType: true,
          scheduledAt: true,
          sequence: { select: { id: true, leadId: true, lead: { select: { name: true } } } },
        },
      }),
    ]);

  const channel = (type: string) => {
    const rows = sent.filter((row) => row.stepType === type);
    const total = rows.reduce((sum, row) => sum + row._count._all, 0);
    const mock = rows
      .filter((row) => row.deliveryMode === "mock")
      .reduce((sum, row) => sum + row._count._all, 0);
    return {
      sent: total,
      of_which_mock: mock,
      failed: failed.find((row) => row.stepType === type)?._count._all ?? 0,
    };
  };

  const notes: string[] = [];
  if (!replyTrackingEnabled()) {
    notes.push("Email reply tracking is switched off on this server, so email replies may be too low.");
  }
  if (outboundMode() === "mock") {
    notes.push("This server is in mock mode: \"sent\" messages were recorded, not really sent.");
  }

  return {
    result: {
      period_days: days,
      email: channel("EMAIL"),
      sms: channel("SMS"),
      replies_received: replies.reduce((sum, row) => sum + row._count._all, 0),
      replies_by_channel: {
        email: replies.find((row) => row.channel === "email")?._count._all ?? 0,
        sms: replies.find((row) => row.channel === "sms")?._count._all ?? 0,
      },
      leads: {
        total: leadTotals.reduce((sum, row) => sum + row._count._all, 0),
        do_not_contact: leadTotals.find((row) => row.doNotContact)?._count._all ?? 0,
        by_stage: leadsByStage.map((row) => ({
          untrusted_stage: row.followUpStage,
          count: row._count._all,
        })),
      },
      sequences_by_status: Object.fromEntries(sequences.map((row) => [row.status, row._count._all])),
      drafts_awaiting_approval: awaiting,
      upcoming_days: upcomingDays,
      next_scheduled_steps: upcoming.map((step) => ({
        at: step.scheduledAt.toISOString(),
        channel: channelOf(step.stepType),
        step_number: step.stepOrder,
        sequence_id: step.sequence.id,
        lead_id: step.sequence.leadId,
        untrusted: { lead_name: step.sequence.lead.name },
      })),
      notes,
    },
    summary: `Read the dashboard numbers for the last ${days} day(s)`,
  };
};

export const ACTIVITY_TYPES = [
  "sent",
  "failed",
  "skipped",
  "replied",
  "paused",
  "resumed",
  "stopped",
  "approved",
  "edited",
  "lead_deleted",
  "do_not_contact_cleared",
  "settings_changed",
] as const;

/**
 * Claude's actions that are not about one sequence. They are read from the
 * run log (agent_run_events), where every tool call is recorded.
 */
const RUN_EVENT_TYPES: Record<string, string> = {
  delete_lead: "lead_deleted",
  clear_do_not_contact: "do_not_contact_cleared",
  update_workspace_settings: "settings_changed",
};

/** One word for what happened, from the activity log's own event names. */
const typeOf = (eventType: string, meta: { from?: unknown; to?: unknown }): string => {
  switch (eventType) {
    case "step_sent":
    case "step_delivered":
      return "sent";
    case "step_failed":
      return "failed";
    case "step_skipped":
      return "skipped";
    case "sequence_created":
      return "created";
    case "approval_requested":
      return "approval_requested";
    case "step_sending":
      return "sending";
    case "sequence_status_changed":
      if (meta.to === "paused") return "paused";
      if (meta.to === "cancelled") return "stopped";
      if (meta.to === "completed") return "completed";
      if (meta.to === "active") return meta.from === "paused" ? "resumed" : "approved";
      return "edited";
    default:
      return "edited";
  }
};

const SCAN_LIMIT = 1000;

export const listRecentActivity = async (
  actor: Actor,
  db: Db,
  input: {
    types?: string[];
    since?: string;
    lead_id?: string;
    page?: number;
    page_size?: number;
  }
): Promise<HarnessOutcome> => {
  const oldest = Date.now() - LIMITS.RECENT_ACTIVITY_MAX_DAYS * DAY_MS;
  let since = new Date(Date.now() - LIMITS.RECENT_ACTIVITY_DEFAULT_DAYS * DAY_MS);
  if (input.since) {
    const asked = new Date(input.since);
    if (Number.isNaN(asked.getTime())) {
      throw new HarnessError("VALIDATION", "since must be a date.", "Pass an ISO date, for example 2026-11-01.");
    }
    since = new Date(Math.max(asked.getTime(), oldest));
  }
  if (input.lead_id) await findLead(db, actor.userId, input.lead_id);

  const { page, size, skip } = pageOf(input);
  const wanted = input.types && input.types.length > 0 ? new Set(input.types) : null;
  const userId = actor.userId;

  const wantedRunTools = Object.entries(RUN_EVENT_TYPES)
    .filter(([, type]) => !wanted || wanted.has(type))
    .map(([tool]) => tool);

  const [activities, replies, runEvents] = await Promise.all([
    db.sequenceActivity.findMany({
      where: {
        createdAt: { gte: since },
        sequence: { userId, ...(input.lead_id ? { leadId: input.lead_id } : {}) },
      },
      orderBy: { createdAt: "desc" },
      take: SCAN_LIMIT,
      include: {
        step: { select: { stepOrder: true, stepType: true } },
        sequence: { select: { id: true, leadId: true, lead: { select: { name: true } } } },
      },
    }),
    !wanted || wanted.has("replied")
      ? db.leadInboundEmail.findMany({
          where: {
            userId,
            receivedAt: { gte: since },
            ...(input.lead_id ? { leadId: input.lead_id } : {}),
          },
          orderBy: { receivedAt: "desc" },
          take: SCAN_LIMIT,
          select: {
            receivedAt: true,
            leadId: true,
            channel: true,
            subject: true,
            lead: { select: { name: true } },
          },
        })
      : [],
    wantedRunTools.length > 0
      ? db.agentRunEvent.findMany({
          where: {
            run: { userId },
            ok: true,
            toolName: { in: wantedRunTools },
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
          take: SCAN_LIMIT,
          select: { createdAt: true, toolName: true, summary: true, touched: true, detail: true },
        })
      : [],
  ]);

  const leadOf = (touched: unknown): string | null => {
    if (!Array.isArray(touched)) return null;
    const lead = touched.find((t) => t && typeof t === "object" && (t as { type?: string }).type === "lead");
    return lead ? String((lead as { id: string }).id) : null;
  };

  const events = [
    ...activities.map((a) => {
      const meta = (a.meta ?? {}) as Record<string, unknown>;
      return {
        at: a.createdAt.toISOString(),
        type: typeOf(a.eventType, meta),
        actor: a.actor,
        sequence_id: a.sequence.id,
        step_number: a.step?.stepOrder ?? null,
        channel: a.step ? channelOf(a.step.stepType) : null,
        lead_id: a.sequence.leadId,
        untrusted: { lead_name: a.sequence.lead.name },
        // May repeat text from a mail or SMS provider: treat as data.
        untrusted_details: meta,
      };
    }),
    ...replies.map((r) => ({
      at: r.receivedAt.toISOString(),
      type: "replied",
      actor: "lead",
      sequence_id: null,
      step_number: null,
      channel: r.channel,
      lead_id: r.leadId,
      untrusted: { lead_name: r.lead.name },
      untrusted_details: { subject: r.subject },
    })),
    ...runEvents
      // A change Claude made "without effect" (repeat call) is not shown.
      .filter((e) => !/nothing was changed/i.test(e.summary))
      .map((e) => {
        const leadId = leadOf(e.touched);
        const touchedLead = Array.isArray(e.touched)
          ? (e.touched as { type?: string; label?: string }[]).find((t) => t?.type === "lead")
          : undefined;
        return {
          at: e.createdAt.toISOString(),
          type: RUN_EVENT_TYPES[e.toolName],
          actor: "claude",
          sequence_id: null,
          step_number: null,
          channel: null,
          lead_id: leadId,
          untrusted: { lead_name: touchedLead?.label ?? null },
          // The summary and reason can repeat a lead's name: treat as data.
          untrusted_details: { summary: e.summary, ...((e.detail ?? {}) as Record<string, unknown>) },
        };
      })
      .filter((e) => !input.lead_id || e.lead_id === input.lead_id),
  ]
    .filter((event) => !wanted || wanted.has(event.type))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const notes: string[] = [];
  if (activities.length === SCAN_LIMIT || replies.length === SCAN_LIMIT || runEvents.length === SCAN_LIMIT) {
    notes.push("There was more activity than could be looked at in one go. Use a later `since` date or a lead_id to narrow it.");
  }
  if (!replyTrackingEnabled()) {
    notes.push("Reply tracking is switched off on this server, so new replies are not recorded.");
  }

  return {
    result: {
      since: since.toISOString(),
      events: events.slice(skip, skip + size),
      ...pagination(page, size, events.length),
      notes,
    },
    summary: `Listed recent activity: ${events.length} event(s)`,
  };
};

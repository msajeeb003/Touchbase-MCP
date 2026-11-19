import { ACTIVITY_TYPES, getDashboard, listRecentActivity } from "../../harness/reports";
import { LIMITS } from "../../harness/limits";
import { defineTool, type HarnessTool } from "../tool-kit";
import { z } from "../zod";
import { page, pageSize, runIdOptional, UNTRUSTED_NOTE } from "./shared";

/** Reporting (MCP_DESIGN.md, section 6.7). Read only. */

export const getDashboardTool = defineTool({
  name: "get_dashboard",
  title: "Get the dashboard numbers",
  kind: "read",
  run: "optional",
  description:
    "Use this when the user asks for numbers: emails and SMS sent and failed, replies received, " +
    "leads by stage, sequences by status, drafts awaiting approval, and the next scheduled messages. " +
    "Email and SMS only. " +
    UNTRUSTED_NOTE,
  input: z.strictObject({
    run_id: runIdOptional,
    days: z.number().int().min(1).max(365).optional().describe("How many days back to count. Default 30."),
    upcoming_days: z.number().int().min(1).max(30).optional().describe("How many days ahead to list scheduled messages. Default 7."),
  }),
  handler: (input, { actor, db }) => getDashboard(actor, db, input),
});

export const listRecentActivityTool = defineTool({
  name: "list_recent_activity",
  title: "List recent activity",
  kind: "read",
  run: "optional",
  description:
    "Use this when the user asks what happened lately across all sequences, for example \"what failed this week?\" " +
    "or \"who replied?\". Newest first. For one sequence, use get_sequence_activity. " +
    UNTRUSTED_NOTE,
  input: z.strictObject({
    run_id: runIdOptional,
    types: z.array(z.enum(ACTIVITY_TYPES)).max(ACTIVITY_TYPES.length).optional().describe("Only these kinds of events."),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use an ISO date")
      .optional()
      .describe(`Only events from this date on. Default ${LIMITS.RECENT_ACTIVITY_DEFAULT_DAYS} days ago, at most ${LIMITS.RECENT_ACTIVITY_MAX_DAYS} days back.`),
    lead_id: z.string().uuid().optional().describe("Only events of this lead."),
    page,
    page_size: pageSize(),
  }),
  handler: (input, { actor, db }) => listRecentActivity(actor, db, input),
});

export const REPORT_TOOLS: HarnessTool<any>[] = [getDashboardTool, listRecentActivityTool];

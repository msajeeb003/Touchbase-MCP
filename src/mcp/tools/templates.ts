import { LIMITS } from "../../harness/limits";
import {
  createTemplate,
  getTemplate,
  getWorkspaceProfile,
  listGoals,
  listTemplates,
  saveGoal,
  updateTemplate,
} from "../../harness/templates";
import { defineTool, type HarnessTool } from "../tool-kit";
import { z } from "../zod";
import { id, runIdOptional, runIdRequired, WRITE_NOTE } from "./shared";

/** Templates, goals and the sender profile (MCP_DESIGN.md, section 6.5). */

const templateName = z.string().trim().min(1).max(LIMITS.TEMPLATE_NAME_MAX);
const stage = z.string().trim().min(1).max(50);
const promptText = z.string().min(10).max(LIMITS.TEMPLATE_PROMPT_MAX);

export const listTemplatesTool = defineTool({
  name: "list_templates",
  title: "List templates",
  kind: "read",
  run: "optional",
  description:
    "Use this to see the user's saved prompt templates: their house style for each follow-up stage. " +
    "There is at most one template per stage.",
  input: z.strictObject({ run_id: runIdOptional }),
  handler: (_input, { actor, db }) => listTemplates(actor, db),
});

export const getTemplateTool = defineTool({
  name: "get_template",
  title: "Read a template",
  kind: "read",
  run: "optional",
  description:
    "Use this to follow the user's house style for a stage: read the template for the lead's stage before writing. " +
    "Follow its goals, tone and booking link. Where it has {{lead.name}}, {{lead.company}} or similar, " +
    "write that lead's own value: a {{placeholder}} must never be left in a step you save. " +
    "If the template differs from the user's instruction, the instruction wins.",
  input: z.strictObject({ run_id: runIdOptional, template_id: id("The template.") }),
  handler: (input, { actor, db }) => getTemplate(actor, db, input),
});

export const createTemplateTool = defineTool({
  name: "create_template",
  title: "Save a template",
  kind: "write",
  run: "required",
  description:
    "Use this to save a new prompt template when the user asks for one. One template per stage: " +
    "if the stage already has one, this answers CONFLICT and you should use update_template instead. " +
    WRITE_NOTE,
  input: z.strictObject({
    run_id: runIdRequired,
    name: templateName.describe("A name for the template (at most 100 characters)."),
    follow_up_stage: stage.describe("The stage it is for, for example \"Proposal sent\" (at most 50 characters)."),
    prompt_text: promptText.describe("The template text: goals, tone, what to mention (10 to 8,000 characters)."),
  }),
  handler: (input, { actor, db }) => createTemplate(actor, db, input),
});

export const updateTemplateTool = defineTool({
  name: "update_template",
  title: "Change a template",
  kind: "write",
  run: "required",
  description:
    "Use this to change a template the user asked you to change. Pass only the fields that change. " +
    "It does not change drafts that were already written. " +
    WRITE_NOTE,
  input: z.strictObject({
    run_id: runIdRequired,
    template_id: id("The template to change."),
    name: templateName.optional(),
    follow_up_stage: stage.optional(),
    prompt_text: promptText.optional(),
  }),
  handler: (input, { actor, db }) => updateTemplate(actor, db, input),
});

export const listGoalsTool = defineTool({
  name: "list_goals",
  title: "List goals",
  kind: "read",
  run: "optional",
  description: "Use this to see the goal labels the user saved, for example \"Book another call\".",
  input: z.strictObject({ run_id: runIdOptional }),
  handler: (_input, { actor, db }) => listGoals(actor, db),
});

export const saveGoalTool = defineTool({
  name: "save_goal",
  title: "Save a goal",
  kind: "write",
  run: "required",
  description:
    "Use this to save a goal label for reuse when the user asks. " +
    "If the same label already exists, it is returned and nothing is added. " +
    WRITE_NOTE,
  input: z.strictObject({
    run_id: runIdRequired,
    label: z.string().trim().min(1).max(LIMITS.GOAL_NAME_MAX).describe("The goal, in a few words."),
  }),
  handler: (input, { actor, db }) => saveGoal(actor, db, input),
});

export const getWorkspaceProfileTool = defineTool({
  name: "get_workspace_profile",
  title: "Get the workspace profile",
  kind: "read",
  run: "optional",
  description:
    "Use this to sign messages correctly and to know what is ready: the sender's name, company and booking link, " +
    "whether email and SMS sending are set up, whether replies are being recorded, " +
    "the hours in which messages may go out, and which actions the user allows you (claude_permissions). " +
    "It returns no key, password or other secret. Email and SMS setup is done by the user in the app, at setup_url. " +
    "The permission switches can only be changed by the user in the app.",
  input: z.strictObject({ run_id: runIdOptional }),
  handler: (_input, { actor, db }) => getWorkspaceProfile(actor, db),
});

export const TEMPLATE_TOOLS: HarnessTool<any>[] = [
  listTemplatesTool,
  getTemplateTool,
  createTemplateTool,
  updateTemplateTool,
  listGoalsTool,
  saveGoalTool,
  getWorkspaceProfileTool,
];

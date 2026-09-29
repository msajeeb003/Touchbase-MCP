import { z } from "zod";
import { generateContent } from "../../shared/services/ai.service";
import type { AIProvider } from "../../shared/constants";
import { GOAL_TYPES } from "../sequence/sequence.validation";
import {
  AUTO_DRAFT_DEFAULTS,
  SELECTOR_TEMPLATE_PREVIEW_CHARS,
  SELECTOR_TRANSCRIPT_MAX_CHARS,
} from "./auto-draft.constants";

const LOG_PREFIX = "[AutoDraft]";

export type TemplateOption = {
  id: string;
  name: string;
  followUpStage: string;
  promptText: string;
};

export type SelectorAiConfig = {
  provider: AIProvider;
  apiKey: string;
  model?: string;
};

export type TemplateSelection = {
  template: TemplateOption;
  goal: string;
  /** "ai" when the model picked both; "stage" when the lead's stage decided the template. */
  source: "ai" | "stage";
  reason?: string;
};

const aiAnswerSchema = z.object({
  templateId: z.string().min(1),
  goal: z.string().min(1),
  reason: z.string().optional(),
});

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[...truncated]`;

const buildSelectionPrompt = (templates: TemplateOption[], transcript: string): string => {
  const templateList = templates
    .map(
      (t) =>
        `- id: ${t.id}\n  name: ${t.name}\n  stage: ${t.followUpStage}\n  preview: ${truncate(
          t.promptText.replace(/\s+/g, " ").trim(),
          SELECTOR_TEMPLATE_PREVIEW_CHARS
        )}`
    )
    .join("\n");

  return `You are choosing how to follow up after a sales meeting.

Below is a list of the user's prompt templates. Each template is written for a specific follow-up situation (its "stage"). Read the meeting transcript and pick the ONE template whose situation matches this meeting best. Then pick the single most fitting goal for the follow-up sequence.

TEMPLATES:
${templateList}

ALLOWED GOALS (choose exactly one, copy it verbatim):
${GOAL_TYPES.map((g) => `- ${g}`).join("\n")}

TRANSCRIPT:
${truncate(transcript, SELECTOR_TRANSCRIPT_MAX_CHARS)}

Return ONLY raw JSON with this shape, no markdown, no explanation outside the JSON:
{"templateId": "<id from the list>", "goal": "<one allowed goal>", "reason": "<one short sentence>"}`;
};

const parseAiAnswer = (raw: string) => {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return aiAnswerSchema.safeParse(JSON.parse(cleaned));
  } catch {
    return null;
  }
};

const templateByStage = (templates: TemplateOption[], stage: string | null): TemplateOption | null =>
  stage ? templates.find((t) => t.followUpStage === stage) ?? null : null;

/**
 * Picks a prompt template and a goal for the lead's meeting.
 * AI first; falls back to the lead's followUpStage; returns null when nothing fits.
 */
export const selectTemplateAndGoal = async (params: {
  templates: TemplateOption[];
  transcript: string;
  leadStage: string | null;
  ai: SelectorAiConfig;
}): Promise<TemplateSelection | null> => {
  const { templates, transcript, leadStage, ai } = params;
  if (templates.length === 0) return null;

  const fallback = (): TemplateSelection | null => {
    const template = templateByStage(templates, leadStage);
    return template ? { template, goal: AUTO_DRAFT_DEFAULTS.fallbackGoal, source: "stage" } : null;
  };

  try {
    const response = await generateContent(
      { provider: ai.provider, apiKey: ai.apiKey, model: ai.model },
      buildSelectionPrompt(templates, transcript),
      { temperature: 0 }
    );

    const parsed = parseAiAnswer(response.content);
    if (!parsed || !parsed.success) {
      console.warn(`${LOG_PREFIX} Selector returned unparsable JSON; falling back to stage`);
      return fallback();
    }

    const template = templates.find((t) => t.id === parsed.data.templateId);
    if (!template) {
      console.warn(`${LOG_PREFIX} Selector picked unknown template ${parsed.data.templateId}; falling back to stage`);
      return fallback();
    }

    const goal = (GOAL_TYPES as readonly string[]).includes(parsed.data.goal)
      ? parsed.data.goal
      : AUTO_DRAFT_DEFAULTS.fallbackGoal;

    return { template, goal, source: "ai", reason: parsed.data.reason };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Selector AI call failed; falling back to stage:`, err);
    return fallback();
  }
};

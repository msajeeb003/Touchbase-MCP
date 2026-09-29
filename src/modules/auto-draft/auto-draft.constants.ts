import type { ChannelType, IntensityType, ToneType } from "../sequence/sequence.validation";

/**
 * Fixed wizard defaults for AutoDraft sequences.
 * These will move to per-user settings once the schema is extended.
 */
export const AUTO_DRAFT_DEFAULTS = {
  tone: "Friendly & Professional" as ToneType,
  intensity: "Standard" as IntensityType,
  cadence: "3 steps over 7 days",
  /** Fathom leads usually have no phone number, so only email steps are safe to send. */
  channels: ["email"] as ChannelType[],
  /** Used when the AI does not return a goal from GOAL_TYPES. */
  fallbackGoal: "Get a reply",
} as const;

/** How much of the transcript the template/goal selector sees (characters). */
export const SELECTOR_TRANSCRIPT_MAX_CHARS = 8000;

/** How much of each template's prompt text the selector sees (characters). */
export const SELECTOR_TEMPLATE_PREVIEW_CHARS = 240;

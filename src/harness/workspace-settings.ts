import type { Actor } from "./actor";
import { clean, type Db } from "./common";
import { HarnessError, type HarnessOutcome } from "./errors";
import { requirePermission } from "./permissions";
import {
  DEFAULT_SEND_WINDOW_END,
  DEFAULT_SEND_WINDOW_START,
  isValidTimeZone,
  parseTimeOfDay,
} from "./send-window";
import { AutoDraftService } from "../modules/auto-draft/auto-draft.service";
import AppError from "../shared/errors/AppError";

/**
 * AI harness: update_workspace_settings, only while "Claude can change
 * settings" is on.
 *
 * A fixed allow-list of plain, non-secret fields. API keys, passwords, SMTP
 * and SMS credentials and the Claude permission switches are not in the list,
 * and the tool's strict input rejects any other field. Email and SMS provider
 * setup stays in the app.
 */

export type WorkspaceSettingsInput = {
  timezone?: string;
  sender_name?: string | null;
  sender_company?: string | null;
  sender_position?: string | null;
  service_description?: string | null;
  booking_link?: string | null;
  send_window_start?: string;
  send_window_end?: string;
  send_on_weekends?: boolean;
  auto_draft_enabled?: boolean;
};

/** Tool field -> user_settings column. Nothing outside this map can be written. */
const COLUMN = {
  timezone: "sendTimezone",
  sender_name: "senderName",
  sender_company: "senderCompany",
  sender_position: "senderPosition",
  service_description: "serviceDescription",
  booking_link: "bookingLink",
  send_window_start: "sendWindowStart",
  send_window_end: "sendWindowEnd",
  send_on_weekends: "sendOnWeekends",
} as const;

type ColumnField = keyof typeof COLUMN;

const invalid = (message: string) =>
  new HarnessError("VALIDATION", message, "Correct the value and call the tool again. Nothing was changed.");

export const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const updateWorkspaceSettings = async (
  actor: Actor,
  db: Db,
  input: WorkspaceSettingsInput
): Promise<HarnessOutcome> => {
  const current = await requirePermission(db, actor.userId, "edit_settings");

  const asked = (Object.keys(input) as (keyof WorkspaceSettingsInput | "run_id")[]).filter(
    (key) => key !== "run_id" && input[key as keyof WorkspaceSettingsInput] !== undefined
  ) as (keyof WorkspaceSettingsInput)[];
  if (asked.length === 0) throw invalid("Pass at least one setting to change.");

  // Check every value before changing anything.
  const next: Partial<Record<ColumnField, string | boolean | null>> = {};
  for (const key of asked) {
    if (key === "auto_draft_enabled") continue;
    const raw = input[key];
    if (typeof raw === "boolean") {
      next[key as ColumnField] = raw;
      continue;
    }
    next[key as ColumnField] = clean(raw as string | null);
  }

  if (asked.includes("timezone")) {
    const tz = next.timezone as string | null;
    if (!tz || !isValidTimeZone(tz)) {
      throw invalid('timezone must be an IANA timezone name, for example "Europe/London" or "Asia/Dhaka".');
    }
  }
  if (asked.includes("booking_link") && next.booking_link !== null) {
    if (!isHttpsUrl(next.booking_link as string)) {
      throw invalid("booking_link must be a full https:// address, for example https://cal.com/you.");
    }
  }
  for (const key of ["send_window_start", "send_window_end"] as const) {
    if (asked.includes(key) && parseTimeOfDay((next[key] as string | null) ?? "") === null) {
      throw invalid(`${key} must be a 24-hour time such as 09:00.`);
    }
  }
  const start = parseTimeOfDay(
    (next.send_window_start as string | undefined) ?? current.sendWindowStart ?? DEFAULT_SEND_WINDOW_START
  );
  const end = parseTimeOfDay(
    (next.send_window_end as string | undefined) ?? current.sendWindowEnd ?? DEFAULT_SEND_WINDOW_END
  );
  if (start === null || end === null || start >= end) {
    throw invalid("The send window start time must be before the end time.");
  }

  // Only the values that really change. Same values again change nothing.
  const changed: string[] = [];
  const data: Record<string, string | boolean | null> = {};
  for (const [key, value] of Object.entries(next) as [ColumnField, string | boolean | null][]) {
    const column = COLUMN[key];
    if ((current as Record<string, unknown>)[column] !== value) {
      data[column] = value;
      changed.push(key);
    }
  }

  const warnings: string[] = [];
  if (input.auto_draft_enabled !== undefined && input.auto_draft_enabled !== current.autoDraftEnabled) {
    // Same path as the Settings page: turning AutoDraft on or off registers or
    // removes the user's Fathom webhook. It is applied on its own, as in the app.
    try {
      const outcome = await AutoDraftService.setEnabled(actor.userId, input.auto_draft_enabled);
      if (outcome.changed) changed.push("auto_draft_enabled");
      if (outcome.warning) warnings.push(outcome.warning);
    } catch (error) {
      if (error instanceof AppError) {
        throw new HarnessError(
          "VALIDATION",
          `AutoDraft could not be changed: ${error.message}`,
          "Tell the user to set this up in Touchbase Settings. Nothing else was changed."
        );
      }
      throw error;
    }
  }

  if (Object.keys(data).length > 0) {
    await db.userSettings.update({ where: { userId: actor.userId }, data });
  }

  return {
    result: {
      changed_fields: changed,
      unchanged: changed.length === 0,
      warnings,
      note: "Email and SMS sending setup, keys and passwords can only be changed in the Touchbase app.",
    },
    summary:
      changed.length > 0
        ? `Changed workspace settings: ${changed.join(", ")}`
        : "Workspace settings were already as asked: nothing was changed",
    detail: { changed_fields: changed },
  };
};

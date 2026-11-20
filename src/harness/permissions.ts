import type { UserSettings } from "@prisma/client";
import type { Db } from "./common";
import { HarnessError } from "./errors";

/**
 * AI harness: what Claude may do in one workspace.
 *
 * Five switches on user_settings, all OFF by default. Only a logged-in person
 * can change them (PATCH /api/v1/settings, login token only). No MCP tool
 * accepts them as input, so Claude can never turn one on for itself.
 *
 * A tool whose switch is off answers HUMAN_ONLY and tells the user where to
 * turn it on.
 */

export type ClaudePermission =
  | "activate"
  | "resume"
  | "edit_settings"
  | "delete_leads"
  | "clear_do_not_contact";

type PermissionField =
  | "claudeCanActivate"
  | "claudeCanResume"
  | "claudeCanEditSettings"
  | "claudeCanDeleteLeads"
  | "claudeCanClearDoNotContact";

const FIELD: Record<ClaudePermission, PermissionField> = {
  activate: "claudeCanActivate",
  resume: "claudeCanResume",
  edit_settings: "claudeCanEditSettings",
  delete_leads: "claudeCanDeleteLeads",
  clear_do_not_contact: "claudeCanClearDoNotContact",
};

/** The switch names exactly as the Settings page shows them. */
export const PERMISSION_LABEL: Record<ClaudePermission, string> = {
  activate: "Claude can activate sequences",
  resume: "Claude can resume sequences",
  edit_settings: "Claude can change settings",
  delete_leads: "Claude can delete leads",
  clear_do_not_contact: "Claude can clear do-not-contact",
};

const ACTION: Record<ClaudePermission, string> = {
  activate: "activate sequences",
  resume: "resume paused sequences",
  edit_settings: "change workspace settings",
  delete_leads: "delete leads",
  clear_do_not_contact: "clear do-not-contact",
};

export const DEFAULT_DAILY_ACTIVATION_CAP = 50;

type PermissionSettings = Pick<UserSettings, PermissionField | "claudeDailyActivationCap"> | null;

/** The switches as Claude sees them in get_workspace_profile. */
export const permissionsView = (s: PermissionSettings) => ({
  activate: s?.claudeCanActivate ?? false,
  resume: s?.claudeCanResume ?? false,
  edit_settings: s?.claudeCanEditSettings ?? false,
  delete_leads: s?.claudeCanDeleteLeads ?? false,
  clear_do_not_contact: s?.claudeCanClearDoNotContact ?? false,
  daily_activation_cap: s?.claudeDailyActivationCap ?? DEFAULT_DAILY_ACTIVATION_CAP,
});

export const permissionOff = (permission: ClaudePermission): HarnessError =>
  new HarnessError(
    "HUMAN_ONLY",
    `Claude may not ${ACTION[permission]} in this workspace: the switch "${PERMISSION_LABEL[permission]}" is off.`,
    `Tell the user to do this in the Touchbase app, or to turn on "${PERMISSION_LABEL[permission]}" in Settings → Claude permissions if they want you to do it.`,
    { setting: PERMISSION_LABEL[permission] }
  );

/** Throws HUMAN_ONLY unless the workspace switch for this action is on. */
export const requirePermission = async (
  db: Db,
  userId: string,
  permission: ClaudePermission
): Promise<UserSettings> => {
  const settings = await db.userSettings.findUnique({ where: { userId } });
  if (!settings || settings[FIELD[permission]] !== true) throw permissionOff(permission);
  return settings;
};

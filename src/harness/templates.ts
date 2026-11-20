import type { PromptTemplate } from "@prisma/client";
import type { Actor } from "./actor";
import { type Db, notFound } from "./common";
import { HarnessError, type HarnessOutcome } from "./errors";
import { LIMITS } from "./limits";
import { permissionsView } from "./permissions";
import { resolveSendWindow, startOfLocalDay } from "./send-window";
import { appUrl, outboundMode, replyTrackingEnabled } from "./switches";

/**
 * AI harness: prompt templates, goal labels and the sender profile.
 *
 * Templates and goals are the user's own words (their house style), so they
 * are returned as plain fields.
 *
 * The workspace profile is a fixed list of non-secret fields. It never
 * contains a key, a password, a token, a host name or a user name. Its plain
 * fields can be changed by update_workspace_settings, only while the
 * workspace switch for it is on (see workspace-settings.ts).
 */

const templateView = (template: PromptTemplate, withText: boolean) => ({
  template_id: template.id,
  name: template.name,
  follow_up_stage: template.followUpStage,
  updated_at: template.updatedAt.toISOString(),
  ...(withText ? { prompt_text: template.promptText } : {}),
});

const findTemplate = async (db: Db, userId: string, templateId: string) => {
  const template = await db.promptTemplate.findFirst({ where: { id: templateId, userId } });
  if (!template) throw notFound("Template");
  return template;
};

/** The template saved for a lead's stage, if the user has one. */
export const templateForStage = async (db: Db, userId: string, stage: string | null) =>
  stage
    ? db.promptTemplate.findFirst({
        where: { userId, followUpStage: { equals: stage, mode: "insensitive" } },
        select: { id: true, name: true },
      })
    : null;

export const listTemplates = async (actor: Actor, db: Db): Promise<HarnessOutcome> => {
  const templates = await db.promptTemplate.findMany({
    where: { userId: actor.userId },
    orderBy: { followUpStage: "asc" },
  });

  return {
    result: { templates: templates.map((t) => templateView(t, false)) },
    summary: `Listed ${templates.length} template(s)`,
  };
};

export const getTemplate = async (
  actor: Actor,
  db: Db,
  input: { template_id: string }
): Promise<HarnessOutcome> => {
  const template = await findTemplate(db, actor.userId, input.template_id);

  return {
    result: {
      template: templateView(template, true),
      how_to_use:
        "This is the user's house style for this stage: follow its goals, tone and booking link. " +
        "Where it says {{lead.name}}, {{lead.company}} or similar, write that lead's own value. " +
        "Never leave a {{placeholder}} in a step you save. If it has a SEQUENCE PLAN block, you may follow it when the user gave no plan. " +
        "If it differs from the user's instruction, the instruction wins.",
    },
    summary: `Read the template "${template.name}"`,
    touched: [{ type: "template", id: template.id, label: template.name }],
  };
};

const checkTemplateText = (text: string) => {
  if (text.length < 10 || text.length > LIMITS.TEMPLATE_PROMPT_MAX) {
    throw new HarnessError(
      "VALIDATION",
      `The template text must be 10 to ${LIMITS.TEMPLATE_PROMPT_MAX} characters.`,
      "Shorten or complete the text and call the tool again."
    );
  }
};

export const createTemplate = async (
  actor: Actor,
  db: Db,
  input: { name: string; follow_up_stage: string; prompt_text: string }
): Promise<HarnessOutcome> => {
  const name = input.name.trim();
  const stage = input.follow_up_stage.trim();
  checkTemplateText(input.prompt_text);

  // The app allows one template per stage.
  const existing = await db.promptTemplate.findFirst({
    where: { userId: actor.userId, followUpStage: { equals: stage, mode: "insensitive" } },
  });

  if (existing) {
    if (existing.name === name && existing.promptText === input.prompt_text) {
      return {
        result: { template: templateView(existing, false), already_existed: true },
        summary: `The template "${existing.name}" already existed: nothing was added`,
        touched: [{ type: "template", id: existing.id, label: existing.name }],
      };
    }
    throw new HarnessError(
      "CONFLICT",
      `The user already has a template for the stage "${existing.followUpStage}" (one per stage).`,
      "Read it with get_template. To change it, use update_template; ask the user first if they did not ask for a change.",
      { existing_template_id: existing.id }
    );
  }

  const template = await db.promptTemplate.create({
    data: { userId: actor.userId, name, followUpStage: stage, promptText: input.prompt_text },
  });

  return {
    result: { template: templateView(template, false), already_existed: false },
    summary: `Saved the template "${template.name}" for the stage "${template.followUpStage}"`,
    touched: [{ type: "template", id: template.id, label: template.name }],
  };
};

export const updateTemplate = async (
  actor: Actor,
  db: Db,
  input: { template_id: string; name?: string; follow_up_stage?: string; prompt_text?: string }
): Promise<HarnessOutcome> => {
  const template = await findTemplate(db, actor.userId, input.template_id);

  const next = {
    name: input.name !== undefined ? input.name.trim() : template.name,
    followUpStage:
      input.follow_up_stage !== undefined ? input.follow_up_stage.trim() : template.followUpStage,
    promptText: input.prompt_text !== undefined ? input.prompt_text : template.promptText,
  };
  if (input.prompt_text !== undefined) checkTemplateText(next.promptText);

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== template[key]
  );
  const labels: Record<string, string> = {
    name: "name",
    followUpStage: "follow_up_stage",
    promptText: "prompt_text",
  };

  if (changed.length === 0) {
    return {
      result: { template: templateView(template, false), changed_fields: [] },
      summary: "The template already had these values: nothing was changed",
      touched: [{ type: "template", id: template.id, label: template.name }],
    };
  }

  if (changed.includes("followUpStage")) {
    const taken = await db.promptTemplate.findFirst({
      where: {
        userId: actor.userId,
        id: { not: template.id },
        followUpStage: { equals: next.followUpStage, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (taken) {
      throw new HarnessError(
        "CONFLICT",
        `The user already has another template for the stage "${next.followUpStage}" (one per stage).`,
        "Keep this template's stage, or change the other template instead.",
        { existing_template_id: taken.id }
      );
    }
  }

  const updated = await db.promptTemplate.update({ where: { id: template.id }, data: next });

  return {
    result: {
      template: templateView(updated, false),
      changed_fields: changed.map((key) => labels[key]),
    },
    summary: `Updated the template "${updated.name}": ${changed.map((key) => labels[key]).join(", ")}`,
    touched: [{ type: "template", id: updated.id, label: updated.name }],
  };
};

export const listGoals = async (actor: Actor, db: Db): Promise<HarnessOutcome> => {
  const goals = await db.sequenceGoal.findMany({
    where: { userId: actor.userId },
    orderBy: { label: "asc" },
  });

  return {
    result: { goals: goals.map((goal) => ({ goal_id: goal.id, label: goal.label })) },
    summary: `Listed ${goals.length} goal(s)`,
  };
};

export const saveGoal = async (
  actor: Actor,
  db: Db,
  input: { label: string }
): Promise<HarnessOutcome> => {
  const label = input.label.trim();
  if (!label || label.length > LIMITS.GOAL_NAME_MAX) {
    throw new HarnessError(
      "VALIDATION",
      `A goal must be 1 to ${LIMITS.GOAL_NAME_MAX} characters.`,
      "Shorten the goal and call the tool again."
    );
  }

  const existing = await db.sequenceGoal.findFirst({
    where: { userId: actor.userId, label: { equals: label, mode: "insensitive" } },
  });
  if (existing) {
    return {
      result: { goal: { goal_id: existing.id, label: existing.label }, already_existed: true },
      summary: `The goal "${existing.label}" already existed: nothing was added`,
      touched: [{ type: "goal", id: existing.id, label: existing.label }],
    };
  }

  const goal = await db.sequenceGoal.create({ data: { userId: actor.userId, label } });

  return {
    result: { goal: { goal_id: goal.id, label: goal.label }, already_existed: false },
    summary: `Saved the goal "${goal.label}"`,
    touched: [{ type: "goal", id: goal.id, label: goal.label }],
  };
};

/**
 * Who the messages are from, which channels are ready, and when messages may
 * go out. Built field by field from an allow-list: a secret cannot slip in by
 * a new column being added to the settings table.
 */
type Settings = Awaited<ReturnType<Db["userSettings"]["findUnique"]>>;

/** Whether email and SMS sending are set up in Settings. Says yes or no, never what the values are. */
export const sendingReady = (s: Settings) => {
  const has = (value: string | number | null | undefined) =>
    value !== null && value !== undefined && String(value).trim() !== "";

  return {
    email: Boolean(
      s && has(s.smtpHost) && has(s.smtpPort) && has(s.smtpUsername) && has(s.smtpPassword)
    ),
    sms: Boolean(
      s &&
        ((s.smsProvider === "twilio" &&
          has(s.twilioAccountSid) &&
          has(s.twilioAuthToken) &&
          has(s.twilioPhoneNumber)) ||
          (s.smsProvider === "textmagic" && has(s.textmagicUsername) && has(s.textmagicApiKey)))
    ),
  };
};

export const getWorkspaceProfile = async (actor: Actor, db: Db): Promise<HarnessOutcome> => {
  const s = await db.userSettings.findUnique({ where: { userId: actor.userId } });
  const { email: emailReady, sms: smsReady } = sendingReady(s);
  const sendWindow = resolveSendWindow(
    s
      ? {
          sendWindowStart: s.sendWindowStart,
          sendWindowEnd: s.sendWindowEnd,
          sendOnWeekends: s.sendOnWeekends,
          sendTimezone: s.sendTimezone,
        }
      : null
  );

  const notes: string[] = [];
  if (!emailReady) notes.push("Email sending is not set up in Settings: approved email steps would fail.");
  if (!smsReady) notes.push("SMS sending is not set up in Settings: approved SMS steps would fail.");
  if (!sendWindow.ok) notes.push(sendWindow.message);
  if (outboundMode() === "mock") {
    notes.push("This server is in mock mode: messages are recorded but not really sent.");
  }

  const permissions = permissionsView(s);
  let activationsLeftToday: number | null = null;
  if (permissions.activate && sendWindow.ok) {
    const used = await db.sequence.count({
      where: {
        userId: actor.userId,
        approvedByActor: "claude",
        approvedAt: { gte: startOfLocalDay(new Date(), sendWindow.window.timeZone) },
      },
    });
    activationsLeftToday = Math.max(0, permissions.daily_activation_cap - used);
  }
  const app = appUrl();

  return {
    result: {
      sender_name: s?.senderName ?? s?.smtpFromName ?? null,
      sender_company: s?.senderCompany ?? null,
      sender_position: s?.senderPosition ?? null,
      service_description: s?.serviceDescription ?? null,
      booking_link: s?.bookingLink ?? null,
      email_ready: emailReady,
      sms_ready: smsReady,
      outbound_mode: outboundMode(),
      reply_tracking_enabled: replyTrackingEnabled(),
      auto_draft_enabled: s?.autoDraftEnabled ?? false,
      send_window: {
        start: s?.sendWindowStart ?? "09:00",
        end: s?.sendWindowEnd ?? "18:00",
        timezone: s?.sendTimezone ?? null,
        weekends: s?.sendOnWeekends ?? false,
        ready: sendWindow.ok,
      },
      // What the user allows Claude to do. Only a person can change these, in Settings.
      claude_permissions: permissions,
      activations_left_today: activationsLeftToday,
      sms_replies_recorded: s?.smsProvider === "twilio",
      // Where the user sets up email and SMS sending and these switches.
      setup_url: app ? `${app}/dashboard/settings` : null,
      notes,
    },
    summary: "Read the workspace profile",
  };
};

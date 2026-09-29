import config from "../../config";
import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { encrypt } from "../../shared/utils/encryption";
import { FathomService } from "../fathom/fathom.service";
import { SettingsService } from "../settings/settings.service";
import {
  readSignatureHeaders,
  verifyFathomSignature,
} from "./fathom-signature";
import { markMessageSeen } from "./delivery-dedupe";
import {
  FathomMeetingPayload,
  fathomMeetingPayloadSchema,
} from "./auto-draft.validation";
import {
  logLeadSyncResult,
  syncLeadsFromFathomMeeting,
} from "./fathom-lead.processor";

const LOG_PREFIX = "[AutoDraft]";
const WEBHOOK_PATH = "/api/v1/auto-draft/webhook/fathom";

const buildDestinationUrl = (userId: string): string => {
  if (!config.public_base_url) {
    throw new AppError(
      400,
      "PUBLIC_BASE_URL is not set. Fathom needs a public HTTPS URL to deliver webhooks."
    );
  }
  return `${config.public_base_url}${WEBHOOK_PATH}/${userId}`;
};

const loadToggleState = (userId: string) =>
  prisma.userSettings.findUnique({
    where: { userId },
    select: { autoDraftEnabled: true, fathomWebhookId: true, fathomApiKey: true },
  });

// --- Toggle ---

type ToggleOutcome = { enabled: boolean; changed: boolean; warning?: string };

const enable = async (userId: string): Promise<ToggleOutcome> => {
  const current = await loadToggleState(userId);

  if (current?.autoDraftEnabled && current.fathomWebhookId) {
    return { enabled: true, changed: false };
  }
  if (!current?.fathomApiKey) {
    throw new AppError(400, "Add your Fathom API key before enabling AutoDraft.");
  }

  const destinationUrl = buildDestinationUrl(userId);
  const webhook = await FathomService.createWebhook(userId, destinationUrl);

  await prisma.userSettings.update({
    where: { userId },
    data: {
      autoDraftEnabled: true,
      fathomWebhookId: webhook.id,
      fathomWebhookSecret: encrypt(webhook.secret),
    },
  });

  console.log(`${LOG_PREFIX} Enabled — Fathom webhook ${webhook.id} → ${destinationUrl}`);
  return { enabled: true, changed: true };
};

const disable = async (userId: string): Promise<ToggleOutcome> => {
  const current = await loadToggleState(userId);

  if (!current || (!current.autoDraftEnabled && !current.fathomWebhookId)) {
    return { enabled: false, changed: false };
  }

  let warning: string | undefined;

  if (current.fathomWebhookId) {
    try {
      await FathomService.deleteWebhook(userId, current.fathomWebhookId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      warning = `AutoDraft disabled, but the Fathom webhook ${current.fathomWebhookId} could not be deleted (${message}). Remove it in Fathom settings.`;
      console.warn(`${LOG_PREFIX} ${warning}`);
    }
  }

  await prisma.userSettings.update({
    where: { userId },
    data: { autoDraftEnabled: false, fathomWebhookId: null, fathomWebhookSecret: null },
  });

  console.log(`${LOG_PREFIX} Disabled for user ${userId}`);
  return { enabled: false, changed: true, warning };
};

const setEnabled = (userId: string, enabled: boolean): Promise<ToggleOutcome> =>
  enabled ? enable(userId) : disable(userId);

const getStatus = async (userId: string) => {
  const current = await loadToggleState(userId);

  return {
    enabled: current?.autoDraftEnabled ?? false,
    webhookId: current?.fathomWebhookId ?? null,
    destinationUrl:
      current?.fathomWebhookId && config.public_base_url
        ? `${config.public_base_url}${WEBHOOK_PATH}/${userId}`
        : null,
    verificationSkipped: config.fathom_webhook.skip_verify && config.env !== "production",
  };
};

// --- Inbound delivery ---

/** Fathom may deliver the meeting at the top level or wrapped; accept both. */
const extractMeeting = (body: unknown): unknown => {
  if (!body || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  if ("recording_id" in record || "calendar_invitees" in record) return record;
  return record.data ?? record.meeting ?? record.recording ?? record;
};

type AcceptedDelivery =
  | { accepted: false; ignored: "disabled" | "duplicate" }
  | { accepted: true; meeting: FathomMeetingPayload };

const acceptFathomWebhook = async (
  userId: string,
  rawBody: Buffer,
  headers: Record<string, unknown>
): Promise<AcceptedDelivery> => {
  const signatureHeaders = readSignatureHeaders(headers);

  console.log(
    `${LOG_PREFIX} Webhook received — user ${userId}, webhook-id ${signatureHeaders.id ?? "(none)"}, body ${rawBody.length} bytes`
  );

  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { autoDraftEnabled: true },
  });
  if (!settings) throw new AppError(404, "Unknown webhook user");

  if (!settings.autoDraftEnabled) {
    console.log(`${LOG_PREFIX} Delivery ignored — AutoDraft is disabled for user ${userId}`);
    return { accepted: false, ignored: "disabled" };
  }

  const skipVerify = config.fathom_webhook.skip_verify && config.env !== "production";

  if (skipVerify) {
    console.warn(`${LOG_PREFIX} Signature verification SKIPPED (FATHOM_WEBHOOK_SKIP_VERIFY=true)`);
  } else {
    const secret = await SettingsService.getDecryptedField(userId, "fathomWebhookSecret");
    if (!secret) {
      throw new AppError(401, "No webhook secret stored for this user. Disable and re-enable AutoDraft.");
    }
    verifyFathomSignature({ secret, rawBody, headers: signatureHeaders });
  }

  if (signatureHeaders.id && !markMessageSeen(signatureHeaders.id)) {
    console.log(`${LOG_PREFIX} Duplicate delivery ${signatureHeaders.id} ignored`);
    return { accepted: false, ignored: "duplicate" };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError(400, "Webhook body is not valid JSON");
  }

  if (config.env === "development") {
    const { transcript, ...withoutTranscript } = (extractMeeting(parsedBody) ?? {}) as Record<string, unknown>;
    console.log(
      `${LOG_PREFIX} Payload (transcript omitted, ${Array.isArray(transcript) ? transcript.length : 0} lines):\n` +
        JSON.stringify(withoutTranscript, null, 2)
    );
  }

  const meeting = fathomMeetingPayloadSchema.safeParse(extractMeeting(parsedBody));
  if (!meeting.success) {
    const topLevelKeys =
      parsedBody && typeof parsedBody === "object" ? Object.keys(parsedBody as object) : [];
    console.error(`${LOG_PREFIX} Unrecognised payload shape. Top-level keys: ${topLevelKeys.join(", ")}`);
    throw new AppError(400, "Webhook payload does not look like a Fathom meeting");
  }

  const invitees = meeting.data.calendar_invitees ?? [];
  console.log(
    `${LOG_PREFIX} Meeting accepted — recording_id ${meeting.data.recording_id ?? "?"}, title "${meeting.data.title ?? ""}", ` +
      `${invitees.length} invitee(s): ${invitees.map((i) => `${i.email ?? "?"}${i.is_external ? " (external)" : ""}`).join(", ")}`
  );

  return { accepted: true, meeting: meeting.data };
};

/** Runs after the HTTP response has been sent; never throws. */
const runLeadSync = async (userId: string, meeting: FathomMeetingPayload): Promise<void> => {
  try {
    const result = await syncLeadsFromFathomMeeting(userId, meeting);
    logLeadSyncResult(userId, result);
  } catch (err) {
    console.error(`${LOG_PREFIX} Lead sync failed for user ${userId}:`, err);
  }
};

export const AutoDraftService = {
  setEnabled,
  getStatus,
  acceptFathomWebhook,
  runLeadSync,
};

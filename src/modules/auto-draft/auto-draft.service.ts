import config from "../../config";
import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { FathomService } from "../fathom/fathom.service";
import {
  readSignatureHeaders,
  verifyFathomSignature,
} from "./fathom-signature";
import {
  clearRegistration,
  getRegistration,
  markMessageSeen,
  resolveWebhookSecret,
  saveRegistration,
} from "./webhook-registry";
import {
  FathomMeetingPayload,
  fathomMeetingPayloadSchema,
  UnregisterWebhookInput,
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

// --- Registration (in-memory for now) ---

const registerFathomWebhook = async (userId: string) => {
  const destinationUrl = buildDestinationUrl(userId);

  const previous = getRegistration(userId);
  if (previous) {
    await FathomService.deleteWebhook(userId, previous.webhookId).catch((err) =>
      console.warn(`${LOG_PREFIX} Could not delete previous webhook ${previous.webhookId}:`, err)
    );
    clearRegistration(userId);
  }

  const webhook = await FathomService.createWebhook(userId, destinationUrl);

  saveRegistration(userId, {
    webhookId: webhook.id,
    secret: webhook.secret,
    destinationUrl,
    registeredAt: new Date(),
  });

  console.log(`${LOG_PREFIX} Registered Fathom webhook ${webhook.id} → ${destinationUrl}`);

  // The secret is returned once so it can be copied into FATHOM_WEBHOOK_SECRET
  // and survive restarts while there is no DB persistence.
  return {
    webhookId: webhook.id,
    destinationUrl,
    secret: webhook.secret,
    note: "Store the secret as FATHOM_WEBHOOK_SECRET in .env; in-memory registration is lost on restart.",
  };
};

const unregisterFathomWebhook = async (userId: string, payload: UnregisterWebhookInput) => {
  const webhookId = payload.webhookId ?? getRegistration(userId)?.webhookId;

  if (!webhookId) {
    throw new AppError(400, "No webhook id given and none registered in this process");
  }

  await FathomService.deleteWebhook(userId, webhookId);
  clearRegistration(userId);

  console.log(`${LOG_PREFIX} Deleted Fathom webhook ${webhookId}`);

  return { webhookId };
};

const getFathomWebhookStatus = (userId: string) => {
  const registration = getRegistration(userId);

  return {
    registered: registration !== null,
    webhookId: registration?.webhookId ?? null,
    destinationUrl: registration?.destinationUrl ?? null,
    registeredAt: registration?.registeredAt ?? null,
    secretSource: registration
      ? "memory"
      : config.fathom_webhook.secret
        ? "env"
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
  | { duplicate: true }
  | { duplicate: false; meeting: FathomMeetingPayload };

const acceptFathomWebhook = async (
  userId: string,
  rawBody: Buffer,
  headers: Record<string, unknown>
): Promise<AcceptedDelivery> => {
  const signatureHeaders = readSignatureHeaders(headers);

  console.log(
    `${LOG_PREFIX} Webhook received — user ${userId}, webhook-id ${signatureHeaders.id ?? "(none)"}, body ${rawBody.length} bytes`
  );

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new AppError(404, "Unknown webhook user");
  const skipVerify = config.fathom_webhook.skip_verify && config.env !== "production";

  if (skipVerify) {
    console.warn(`${LOG_PREFIX} Signature verification SKIPPED (FATHOM_WEBHOOK_SKIP_VERIFY=true)`);
  } else {
    const secret = resolveWebhookSecret(userId);
    if (!secret) {
      throw new AppError(401, "No webhook secret available for this user");
    }
    verifyFathomSignature({ secret, rawBody, headers: signatureHeaders });
  }

  if (signatureHeaders.id && !markMessageSeen(signatureHeaders.id)) {
    console.log(`${LOG_PREFIX} Duplicate delivery ${signatureHeaders.id} ignored`);
    return { duplicate: true };
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

  return { duplicate: false, meeting: meeting.data };
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
  registerFathomWebhook,
  unregisterFathomWebhook,
  getFathomWebhookStatus,
  acceptFathomWebhook,
  runLeadSync,
};

import config from "../../config";

/**
 * Process-local storage for the proof of concept.
 * Nothing here survives a restart; the DB schema is intentionally untouched for now.
 * `FATHOM_WEBHOOK_SECRET` in .env acts as a fallback secret across restarts.
 */

export type WebhookRegistration = {
  webhookId: string;
  secret: string;
  destinationUrl: string;
  registeredAt: Date;
};

const registrations = new Map<string, WebhookRegistration>();

export const saveRegistration = (
  userId: string,
  registration: WebhookRegistration
): void => {
  registrations.set(userId, registration);
};

export const getRegistration = (userId: string): WebhookRegistration | null =>
  registrations.get(userId) ?? null;

export const clearRegistration = (userId: string): void => {
  registrations.delete(userId);
};

/** In-memory registration wins; otherwise the env fallback; null when neither is set. */
export const resolveWebhookSecret = (userId: string): string | null =>
  registrations.get(userId)?.secret || config.fathom_webhook.secret || null;

// --- Delivery de-duplication (bounded, in-memory) ---

const MAX_SEEN_MESSAGE_IDS = 1000;
const seenMessageIds = new Set<string>();

/** Returns true the first time a message id is seen, false on any repeat. */
export const markMessageSeen = (messageId: string): boolean => {
  if (seenMessageIds.has(messageId)) return false;

  seenMessageIds.add(messageId);

  if (seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = seenMessageIds.values().next().value;
    if (oldest !== undefined) seenMessageIds.delete(oldest);
  }

  return true;
};

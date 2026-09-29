/**
 * Bounded in-memory de-duplication of webhook deliveries by `webhook-id`.
 * Survives only for the life of the process; the DB-level (lead, recording) checks
 * in the processor are the durable safeguard.
 */

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

import { LIMITS } from "./limits";

/**
 * AI harness: tool calls per minute, per access token.
 *
 * Kept in memory: enough for one backend process on one computer (stage 1).
 * With several processes each one counts on its own, so the real ceiling is
 * the limit times the number of processes.
 */
const WINDOW_MS = 60_000;
const calls = new Map<string, number[]>();

export const checkRateLimit = (
  key: string,
  now: number = Date.now()
): { ok: true } | { ok: false; retryAfterSeconds: number } => {
  const recent = (calls.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= LIMITS.TOOL_CALLS_PER_MINUTE) {
    calls.set(key, recent);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((WINDOW_MS - (now - recent[0])) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }

  recent.push(now);
  calls.set(key, recent);
  return { ok: true };
};

/** For tests. */
export const resetRateLimits = (): void => {
  calls.clear();
};

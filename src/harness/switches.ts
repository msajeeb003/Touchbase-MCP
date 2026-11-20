/**
 * AI harness: the environment switches, all in one place.
 *
 * Each switch is read at the moment it is asked for (not once at start-up),
 * so a test can change it and so a wrong value cannot be cached.
 *
 *   OUTBOUND_MODE              "mock" (default) | "live"
 *   ENABLE_SEND_PROCESSOR      "true" to run the send cron (always on when NODE_ENV=production)
 *   ENABLE_PROVIDER_WEBHOOKS   on by default; "false" turns the call and WhatsApp webhooks off
 *   ENABLE_REPLY_TRACKING      "true" to read mailboxes for replies (never in mock mode)
 *   ENABLE_MCP                 "true" to answer at /mcp and the OAuth sign-in pages
 *   MCP_PUBLIC                 "true" to answer from the internet (needs an https MCP_PUBLIC_URL)
 *   MCP_PUBLIC_URL             this backend's public address, e.g. https://api.touchbase.example
 *   APP_URL                    the Touchbase app address, for the Settings link given to Claude
 *   CRON_SECRET                turns on the send-job endpoint (/api/v1/internal/send-tick)
 *                              for hosts with no always-running process (Vercel)
 */
export type DeliveryMode = "live" | "mock";

const read = (name: string): string => (process.env[name] ?? "").trim().toLowerCase();

/** "mock" unless OUTBOUND_MODE is exactly "live". In mock mode nothing leaves the server. */
export const outboundMode = (): DeliveryMode =>
  read("OUTBOUND_MODE") === "live" ? "live" : "mock";

export const isMockMode = (): boolean => outboundMode() === "mock";

/** The send cron runs in production, or when it is switched on by hand. */
export const sendProcessorEnabled = (): boolean =>
  read("NODE_ENV") === "production" || read("ENABLE_SEND_PROCESSOR") === "true";

/** Call (Retell) and WhatsApp (Twilio) webhooks. On unless set to "false". */
export const providerWebhooksEnabled = (): boolean =>
  read("ENABLE_PROVIDER_WEBHOOKS") !== "false";

/**
 * Reading mailboxes for lead replies. Off unless switched on, and always off in
 * mock mode, so a local or test server never signs in to a real mailbox.
 */
export const replyTrackingEnabled = (): boolean =>
  read("ENABLE_REPLY_TRACKING") === "true" && !isMockMode();

/**
 * The MCP endpoint (/mcp) that Claude connects to. Off unless ENABLE_MCP=true.
 * In this stage it answers only connections from this computer, and only with
 * an access token. Leave it off on a public server until the remote stage
 * (OAuth, HTTPS) is built.
 */
export const mcpEnabled = (): boolean => read("ENABLE_MCP") === "true";

/**
 * The public address of this backend, as customers' Claude reaches it, for
 * example "https://api.touchbase.example". It is the OAuth issuer, and the MCP
 * address is this plus "/mcp". Not lower-cased: it is returned as written.
 */
export const mcpPublicUrl = (): string =>
  (process.env.MCP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");

/**
 * Public mode: /mcp and the sign-in pages answer connections from the
 * internet (through HTTPS on the live server), not only from this computer.
 * Needs ENABLE_MCP=true, MCP_PUBLIC=true and an https MCP_PUBLIC_URL.
 */
export const mcpPublic = (): boolean =>
  mcpEnabled() && read("MCP_PUBLIC") === "true" && mcpPublicUrl().startsWith("https://");

/**
 * APP_URL: the address of the Touchbase app (the frontend), for example
 * https://app.touchbase.example. Used only to give Claude a link to the
 * Settings page (get_workspace_profile.setup_url). Not set: no link.
 */
export const appUrl = (): string =>
  (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");

/**
 * CRON_SECRET: the shared secret a scheduler sends to the send-job endpoint
 * as "Authorization: Bearer <secret>" (Vercel Cron sends exactly this when
 * the project has CRON_SECRET set). Not set: the endpoint is off (404).
 * Not lower-cased: it is a secret, compared exactly.
 */
export const cronSecret = (): string => (process.env.CRON_SECRET ?? "").trim();

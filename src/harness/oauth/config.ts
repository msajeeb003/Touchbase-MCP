import config from "../../config";
import { mcpPublicUrl } from "../switches";

/**
 * OAuth 2.1 for the AI harness: the standard way each customer connects
 * Claude to their own Touchbase account.
 *
 * Touchbase itself is the sign-in server (like Slack or Notion): the customer
 * logs in with the Touchbase email and password they already have, approves
 * the app, and the app gets keys that act for that customer only.
 */

export const OAUTH_SCOPE = "touchbase:harness";
export const OFFLINE_SCOPE = "offline_access";
export const SUPPORTED_SCOPES = [OAUTH_SCOPE, OFFLINE_SCOPE];

export const ACCESS_TOKEN_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_DAYS = 30;
export const CODE_SECONDS = 10 * 60; // 10 minutes
export const SIGNED_REQUEST_SECONDS = 15 * 60; // time to fill in the login page

/** Who issues the keys: the public address, or this computer in local mode. */
export const issuer = (): string => mcpPublicUrl() || `http://127.0.0.1:${config.port}`;

/** The MCP address the keys are for. Claude's "resource" must equal it exactly. */
export const resourceUrl = (): string => `${issuer()}/mcp`;

export const protectedResourceMetadataUrl = (): string =>
  `${issuer()}/.well-known/oauth-protected-resource/mcp`;

/** What the sign-in page tells the customer an app will be able to do. */
export const PERMISSIONS_TEXT = [
  "Read your leads, notes, call transcripts and replies",
  "Prepare draft follow-ups and ask you to approve them",
  "Pause or stop follow-up sequences",
];

export const CANNOT_TEXT = "It cannot send any message or approve anything. You stay in control in Touchbase.";

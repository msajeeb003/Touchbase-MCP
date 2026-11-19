import { randomBytes } from "crypto";
import { lookup } from "dns/promises";
import net from "net";
import prisma from "../../shared/prisma";
import { OAuthError } from "./errors";

/**
 * The apps that may ask customers to sign in (for example Claude).
 *
 * An app is known in one of two standard ways:
 *  - Client ID Metadata Document (CIMD): its client_id is an https URL that
 *    serves a small JSON file about it. Claude uses this one.
 *  - Dynamic Client Registration (RFC 7591): it registers itself once and
 *    gets a "tbc_..." client_id.
 *
 * Either way it is a public client (no secret): PKCE protects the sign-in.
 */

export type OAuthClientInfo = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  kind: "dcr" | "cimd";
};

const MAX_REDIRECT_URIS = 10;
const MAX_METADATA_BYTES = 64 * 1024;
const METADATA_TIMEOUT_MS = 5_000;
const METADATA_CACHE_HOURS = 24;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const invalidMetadata = (description: string) =>
  new OAuthError("invalid_client_metadata", description);

/** A return address must be https, or http on this computer (a desktop or command-line app). */
const checkRedirectUri = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 500) {
    throw invalidMetadata("Each redirect_uri must be a text of at most 500 characters.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidMetadata(`"${value.slice(0, 80)}" is not a valid address.`);
  }
  if (url.hash || url.username || url.password) {
    throw invalidMetadata("A redirect_uri may not have a #fragment or a user name.");
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw invalidMetadata("A redirect_uri must use https (or http on localhost).");
  }
  return value;
};

const checkRedirectUris = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REDIRECT_URIS) {
    throw invalidMetadata(`redirect_uris must list 1 to ${MAX_REDIRECT_URIS} addresses.`);
  }
  return value.map(checkRedirectUri);
};

const cleanName = (value: unknown, fallback: string): string => {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, "").trim() : "";
  return (text || fallback).slice(0, 100);
};

/**
 * Is this return address allowed for this app? An exact match, except that
 * for http on localhost the port is ignored: desktop and command-line apps
 * (Claude Code) pick a free port each time.
 */
export const redirectUriAllowed = (client: OAuthClientInfo, requested: string): boolean => {
  if (client.redirectUris.includes(requested)) return true;
  let wanted: URL;
  try {
    wanted = new URL(requested);
  } catch {
    return false;
  }
  if (wanted.protocol !== "http:" || !LOOPBACK_HOSTS.has(wanted.hostname) || wanted.hash) return false;

  return client.redirectUris.some((registered) => {
    try {
      const allowed = new URL(registered);
      return (
        allowed.protocol === "http:" &&
        allowed.hostname === wanted.hostname &&
        allowed.pathname === wanted.pathname &&
        allowed.search === wanted.search
      );
    } catch {
      return false;
    }
  });
};

// ── Dynamic Client Registration ──────────────────────────────────────

const registrations = new Map<string, number[]>();
const REGISTRATIONS_PER_HOUR = 30;

/** RFC 7591. Open to anyone, so it is limited per address and stores only public facts. */
export const registerClient = async (body: Record<string, unknown>, requesterKey: string) => {
  const now = Date.now();
  const recent = (registrations.get(requesterKey) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= REGISTRATIONS_PER_HOUR) {
    throw new OAuthError("invalid_request", "Too many registrations from this address. Try again later.", 429);
  }

  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    throw invalidMetadata('Only public clients are supported: token_endpoint_auth_method must be "none".');
  }
  const grantTypes = (body.grant_types as unknown[] | undefined) ?? ["authorization_code", "refresh_token"];
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")
  ) {
    throw invalidMetadata("grant_types may only contain authorization_code and refresh_token.");
  }

  const redirectUris = checkRedirectUris(body.redirect_uris);
  const clientName = cleanName(body.client_name, "Unnamed app");
  const clientId = `tbc_${randomBytes(18).toString("base64url")}`;

  const created = await prisma.oAuthClient.create({
    data: { clientId, clientName, redirectUris, kind: "dcr" },
  });
  recent.push(now);
  registrations.set(requesterKey, recent);

  return {
    client_id: created.clientId,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
    client_name: created.clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
};

// ── Client ID Metadata Documents ─────────────────────────────────────

/** Fetches the JSON document at a URL. Replaced in tests, which have no internet. */
export type MetadataFetcher = (url: URL) => Promise<unknown>;

/** Private, loopback and link-local addresses: a metadata URL may never point inside a network. */
const isPrivateAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return (
    lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
    lower.startsWith("fe80") || lower.startsWith("ff")
  );
};

const defaultFetcher: MetadataFetcher = async (url) => {
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new OAuthError("invalid_client", "The client_id URL points to a private address.", 401);
  }

  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new OAuthError("invalid_client", `The client metadata document answered ${response.status}.`, 401);
  }
  const text = await response.text();
  if (text.length > MAX_METADATA_BYTES) {
    throw new OAuthError("invalid_client", "The client metadata document is too large.", 401);
  }
  return JSON.parse(text);
};

let fetcher: MetadataFetcher = defaultFetcher;

/** For tests only. */
export const setMetadataFetcherForTests = (replacement: MetadataFetcher | null) => {
  fetcher = replacement ?? defaultFetcher;
};

const loadMetadataDocument = async (clientId: string): Promise<OAuthClientInfo> => {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "Unknown client.", 401);
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) {
    throw new OAuthError("invalid_client", "A client_id URL must be https with a path.", 401);
  }

  let document: Record<string, unknown>;
  try {
    document = (await fetcher(url)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client", "The client metadata document could not be read.", 401);
  }

  if (!document || typeof document !== "object" || document.client_id !== clientId) {
    throw new OAuthError("invalid_client", "The client metadata document does not name this client_id.", 401);
  }
  const method = document.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    throw new OAuthError("invalid_client", "Only public clients are supported.", 401);
  }

  let redirectUris: string[];
  try {
    redirectUris = checkRedirectUris(document.redirect_uris);
  } catch (error) {
    throw new OAuthError("invalid_client", (error as Error).message, 401);
  }

  return {
    clientId,
    clientName: cleanName(document.client_name, url.hostname),
    redirectUris,
    kind: "cimd",
  };
};

/** The app behind a client_id, or invalid_client. A metadata document is re-read once a day. */
export const resolveClient = async (clientId: string): Promise<OAuthClientInfo> => {
  if (!clientId || clientId.length > 500) {
    throw new OAuthError("invalid_client", "Unknown client.", 401);
  }

  const stored = await prisma.oAuthClient.findUnique({ where: { clientId } });
  const isUrl = clientId.startsWith("https://");

  if (!isUrl) {
    if (!stored || stored.kind !== "dcr") throw new OAuthError("invalid_client", "Unknown client.", 401);
    return {
      clientId,
      clientName: stored.clientName,
      redirectUris: stored.redirectUris as string[],
      kind: "dcr",
    };
  }

  const fresh =
    stored &&
    stored.kind === "cimd" &&
    Date.now() - (stored.lastUsedAt ?? stored.createdAt).getTime() < METADATA_CACHE_HOURS * 3_600_000;
  if (fresh) {
    return { clientId, clientName: stored.clientName, redirectUris: stored.redirectUris as string[], kind: "cimd" };
  }

  const loaded = await loadMetadataDocument(clientId);
  await prisma.oAuthClient.upsert({
    where: { clientId },
    create: { clientId, clientName: loaded.clientName, redirectUris: loaded.redirectUris, kind: "cimd", lastUsedAt: new Date() },
    update: { clientName: loaded.clientName, redirectUris: loaded.redirectUris, kind: "cimd", lastUsedAt: new Date() },
  });
  return loaded;
};

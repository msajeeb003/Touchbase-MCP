import { Request, Response, Router } from "express";
import prisma from "../../shared/prisma";
import { comparePassword } from "../../modules/auth/auth.utils";
import { mcpNetworkGates } from "../../mcp/network";
import { redirectUriAllowed, registerClient, resolveClient } from "./clients";
import {
  issuer,
  OAUTH_SCOPE,
  OFFLINE_SCOPE,
  resourceUrl,
  SUPPORTED_SCOPES,
} from "./config";
import { isOAuthError, OAuthError } from "./errors";
import {
  type AuthorizeRequest,
  consentPage,
  errorPage,
  PAGE_HEADERS,
  readSignedRequest,
} from "./pages";
import { createAuthorizationCode, exchangeCode, refreshTokens, revokeOAuthToken } from "./tokens";

/**
 * The OAuth 2.1 endpoints (the standard sign-in that Claude and other apps use):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   which sign-in server protects /mcp (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server       what this sign-in server supports (RFC 8414)
 *   POST /oauth/register                               an app registers itself (RFC 7591)
 *   GET  /oauth/authorize                              the customer's login-and-allow page
 *   POST /oauth/authorize                              the customer pressed Allow or Cancel
 *   POST /oauth/token                                  the app trades a code, or a refresh key, for keys
 *   POST /oauth/revoke                                 the app gives a key back (RFC 7009)
 *
 * They answer only when ENABLE_MCP=true, behind the same network gates as /mcp.
 */

const FAILED_LOGINS_PER_15_MIN = 10;
const failedLogins = new Map<string, number[]>();

const tooManyFailedLogins = (key: string): boolean => {
  const now = Date.now();
  const recent = (failedLogins.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  failedLogins.set(key, recent);
  return recent.length >= FAILED_LOGINS_PER_15_MIN;
};

const recordFailedLogin = (key: string) => {
  failedLogins.set(key, [...(failedLogins.get(key) ?? []), Date.now()]);
};

/** For tests only. */
export const resetLoginLimitsForTests = () => failedLogins.clear();

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const sendJsonError = (res: Response, error: unknown) => {
  if (isOAuthError(error)) {
    res.status(error.status).set("Cache-Control", "no-store").json({
      error: error.error,
      error_description: error.message,
    });
    return;
  }
  console.error("[OAuth]", error);
  res.status(500).set("Cache-Control", "no-store").json({
    error: "server_error",
    error_description: "Something went wrong. Try again.",
  });
};

const redirectWith = (res: Response, redirectUri: string, params: Record<string, string | null>) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== "") url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuer());
  res.redirect(302, url.toString());
};

const protectedResourceMetadata = (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store").json({
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Touchbase",
  });
};

const authorizationServerMetadata = (_req: Request, res: Response) => {
  const base = issuer();
  res.set("Cache-Control", "no-store").json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SUPPORTED_SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
};

/** Checks an authorization request. Errors about the app itself are shown on a page, never redirected. */
const checkAuthorizeRequest = async (query: Record<string, unknown>) => {
  const clientId = text(query.client_id);
  const redirectUri = text(query.redirect_uri);

  let client;
  try {
    client = await resolveClient(clientId);
  } catch {
    return { page: "The app's identity (client_id) is not known to Touchbase." } as const;
  }
  if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
    return { page: "The app asked to return to an address it did not register." } as const;
  }

  const state = text(query.state) || null;
  const fail = (error: string, description: string) =>
    ({ redirect: { redirectUri, params: { error, error_description: description, state } } }) as const;

  if (text(query.response_type) !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (text(query.code_challenge_method) !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(text(query.code_challenge))) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }

  const requested = text(query.scope).split(" ").filter(Boolean);
  if (requested.some((s) => !SUPPORTED_SCOPES.includes(s))) {
    return fail("invalid_scope", `Supported scopes: ${SUPPORTED_SCOPES.join(" ")}.`);
  }
  const scope = [OAUTH_SCOPE, ...(requested.includes(OFFLINE_SCOPE) ? [OFFLINE_SCOPE] : [])].join(" ");

  const resource = text(query.resource) || resourceUrl();
  if (resource !== resourceUrl()) return fail("invalid_target", `resource must be ${resourceUrl()}.`);

  const request: AuthorizeRequest = {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    state,
    codeChallenge: text(query.code_challenge),
    scope,
    resource,
  };
  return { request } as const;
};

const router = Router();
router.use(["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth"], ...mcpNetworkGates);

router.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
router.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
router.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);

router.post("/oauth/register", async (req, res) => {
  try {
    const registered = await registerClient((req.body ?? {}) as Record<string, unknown>, req.ip ?? "unknown");
    res.status(201).set("Cache-Control", "no-store").json(registered);
  } catch (error) {
    sendJsonError(res, error);
  }
});

router.get("/oauth/authorize", async (req, res) => {
  const checked = await checkAuthorizeRequest(req.query as Record<string, unknown>);
  if ("page" in checked) {
    res.status(400).set(PAGE_HEADERS).send(errorPage(checked.page as string));
    return;
  }
  if ("redirect" in checked) {
    redirectWith(res, checked.redirect.redirectUri, checked.redirect.params);
    return;
  }
  res.status(200).set(PAGE_HEADERS).send(consentPage(checked.request));
});

router.post("/oauth/authorize", async (req, res) => {
  const request = readSignedRequest(req.body?.request);
  if (!request) {
    res.status(400).set(PAGE_HEADERS).send(errorPage("This sign-in page has expired or was changed. Start again from the app."));
    return;
  }

  if (text(req.body?.action) !== "allow") {
    redirectWith(res, request.redirectUri, {
      error: "access_denied",
      error_description: "The user did not allow access.",
      state: request.state,
    });
    return;
  }

  const email = text(req.body?.email).trim();
  const password = text(req.body?.password);
  const limitKey = `${(req.ip ?? "unknown")}|${email.toLowerCase()}`;

  if (tooManyFailedLogins(limitKey)) {
    res.status(429).set(PAGE_HEADERS).send(
      consentPage(request, { email, error: "Too many wrong attempts. Wait 15 minutes and try again." })
    );
    return;
  }

  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  const passwordOk = user ? await comparePassword(password, user.passwordHash).catch(() => false) : false;
  if (!user || !passwordOk) {
    recordFailedLogin(limitKey);
    res.status(401).set(PAGE_HEADERS).send(consentPage(request, { email, error: "Wrong email or password." }));
    return;
  }

  const code = await createAuthorizationCode({
    clientId: request.clientId,
    userId: user.id,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    resource: request.resource,
  });
  redirectWith(res, request.redirectUri, { code, state: request.state });
});

router.post("/oauth/token", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = text(body.grant_type);
    const client = await resolveClient(text(body.client_id));
    const resource = text(body.resource) || undefined;

    if (grantType === "authorization_code") {
      const tokens = await exchangeCode({
        code: text(body.code),
        clientId: client.clientId,
        clientName: client.clientName,
        redirectUri: text(body.redirect_uri),
        codeVerifier: text(body.code_verifier),
        resource,
      });
      res.status(200).set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json(tokens);
      return;
    }
    if (grantType === "refresh_token") {
      const tokens = await refreshTokens({ refreshToken: text(body.refresh_token), clientId: client.clientId, resource });
      res.status(200).set({ "Cache-Control": "no-store", Pragma: "no-cache" }).json(tokens);
      return;
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (error) {
    sendJsonError(res, error);
  }
});

router.post("/oauth/revoke", async (req, res) => {
  try {
    const token = text(req.body?.token);
    if (token) await revokeOAuthToken(token);
    res.status(200).set("Cache-Control", "no-store").end();
  } catch (error) {
    sendJsonError(res, error);
  }
});

export const OAuthRoutes = router;

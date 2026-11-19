// The standard OAuth 2.1 sign-in: each customer connects Claude to their own
// Touchbase account. Tested end to end against the real app on a local port,
// including with the official MCP client, which signs in the way Claude does.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import {
  apiClient,
  callTool,
  connectMcp,
  makeLead,
  prisma,
  resetDb,
  startApp,
  tokenFor,
  withEnv,
} from "./helpers/setup";
import { hashPassword } from "../src/modules/auth/auth.utils";
import { setMetadataFetcherForTests } from "../src/harness/oauth/clients";
import { resetLoginLimitsForTests } from "../src/harness/oauth/routes";
import { resetRateLimits } from "../src/harness/rate-limit";

let app: Awaited<ReturnType<typeof startApp>>;
let base = "";
const PASSWORD = "correct horse battery staple";
const CALLBACK = "http://localhost:3118/callback";

before(async () => {
  app = await startApp();
  base = `http://127.0.0.1:${app.port}`;
  process.env.ENABLE_MCP = "true";
  // The issuer and the MCP address are this test server.
  process.env.MCP_PUBLIC_URL = base;
});
after(async () => {
  delete process.env.ENABLE_MCP;
  delete process.env.MCP_PUBLIC_URL;
  setMetadataFetcherForTests(null);
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  resetLoginLimitsForTests();
  setMetadataFetcherForTests(null);
});

// ── helpers ──────────────────────────────────────────────────────────

const makeCustomer = async (email: string) =>
  prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } });

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const register = async (body: Record<string, unknown> = {}) => {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Claude",
      redirect_uris: ["http://localhost/callback", "https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      ...body,
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const authorizeUrl = (clientId: string, challenge: string, extra: Record<string, string> = {}) => {
  const url = new URL(`${base}/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    scope: "touchbase:harness offline_access",
    resource: `${base}/mcp`,
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) if (v !== "") url.searchParams.set(k, v);
  return url;
};

const hiddenRequest = (html: string) => /name="request" value="([^"]+)"/.exec(html)?.[1].replace(/&quot;/g, '"') ?? "";

const submit = (request: string, fields: Record<string, string>) =>
  fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, ...fields }).toString(),
  });

const tokenRequest = (fields: Record<string, string>) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

/** The whole sign-in, the way an app does it. Returns the keys. */
const signIn = async (email: string, clientId?: string) => {
  const id = clientId ?? (await register()).body.client_id;
  const { verifier, challenge } = pkce();
  const page = await fetch(authorizeUrl(id, challenge));
  assert.equal(page.status, 200);
  const allowed = await submit(hiddenRequest(await page.text()), { action: "allow", email, password: PASSWORD });
  assert.equal(allowed.status, 302);
  const location = new URL(allowed.headers.get("location") as string);
  const code = location.searchParams.get("code") as string;
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: id,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  return { clientId: id, location, code, verifier, ...tokens.body };
};

const mcpStatus = (token: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  }).then((r) => r.status);

// ── discovery ────────────────────────────────────────────────────────

test("discovery: /mcp without a key points to the sign-in information, which says what is supported", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));

  const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  assert.equal(resource.resource, `${base}/mcp`, "must equal the address the customer enters");
  assert.deepEqual(resource.authorization_servers, [base]);

  const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
  assert.equal(server.issuer, base);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(server.client_id_metadata_document_supported, true);
  assert.ok(server.scopes_supported.includes("offline_access"));
  assert.equal(server.registration_endpoint, `${base}/oauth/register`);

  await withEnv({ ENABLE_MCP: undefined }, async () => {
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404, "off unless switched on");
  });
});

// ── the official MCP client, signing in like Claude ─────────────────

test("the official MCP client signs in with OAuth and then uses the tools as that customer", async () => {
  const customer = await makeCustomer("dana.owner@example.com");
  await makeLead(customer.id, { name: "Lead Of Dana" });

  const store: Record<string, any> = {};
  const provider = {
    get redirectUrl() {
      return CALLBACK;
    },
    get clientMetadata() {
      return {
        client_name: "Claude (test)",
        redirect_uris: ["http://localhost/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => store.client,
    saveClientInformation: (info: unknown) => void (store.client = info),
    tokens: () => store.tokens,
    saveTokens: (tokens: unknown) => void (store.tokens = tokens),
    redirectToAuthorization: (url: URL) => void (store.authUrl = url),
    saveCodeVerifier: (v: string) => void (store.verifier = v),
    codeVerifier: () => store.verifier,
  };

  // 1. the first connection is refused and the client is sent to sign in
  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider as any });
  await assert.rejects(new Client({ name: "c", version: "1" }).connect(first), UnauthorizedError);
  assert.ok(store.client?.client_id, "the client registered itself");
  const authUrl: URL = store.authUrl;
  assert.equal(authUrl.origin + authUrl.pathname, `${base}/oauth/authorize`);
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("resource"), `${base}/mcp`);

  // 2. the customer sees the page and allows it
  const page = await fetch(authUrl);
  const html = await page.text();
  assert.match(html, /Claude \(test\)<\/span> wants to use your Touchbase account/);
  assert.match(html, /cannot send any message or approve anything/);
  const allowed = await submit(hiddenRequest(html), { action: "allow", email: customer.email, password: PASSWORD });
  const back = new URL(allowed.headers.get("location") as string);
  assert.equal(back.origin + back.pathname, CALLBACK);
  assert.equal(back.searchParams.get("iss"), base);

  // 3. the client finishes the sign-in and works
  await first.finishAuth(back.searchParams.get("code") as string, back.searchParams.get("iss") as string);
  assert.ok(store.tokens?.access_token?.startsWith("tb_oat_"));
  assert.ok(store.tokens?.refresh_token?.startsWith("tb_ort_"));

  const client = new Client({ name: "c", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider as any }));
  assert.equal((await client.listTools()).tools.length, 37);
  const started = await callTool(client, "start_run", { instruction: "Signed in with OAuth" });
  const found = await callTool(client, "search_leads", { run_id: started.data.run_id });
  await client.close();

  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.data.run_id } });
  assert.equal(run.userId, customer.id, "the run belongs to the customer who signed in");
  assert.deepEqual(found.data.leads.map((l: any) => l.untrusted.name), ["Lead Of Dana"]);
  const grants = await prisma.oAuthGrant.findMany({ where: { userId: customer.id } });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].clientName, "Claude (test)");
});

// ── many customers ───────────────────────────────────────────────────

test("two customers connect their own Claude: each one sees only their own account", async () => {
  const alice = await makeCustomer("alice@example.com");
  const bob = await makeCustomer("bob@example.com");
  const aliceLead = await makeLead(alice.id, { name: "Alice's Lead" });
  const bobLead = await makeLead(bob.id, { name: "Bob's Lead" });

  const asAlice = await connectMcp(app.mcpUrl, (await signIn(alice.email)).access_token);
  const asBob = await connectMcp(app.mcpUrl, (await signIn(bob.email)).access_token);

  const aliceSees = await callTool(asAlice, "search_leads", {});
  const bobSees = await callTool(asBob, "search_leads", {});
  assert.deepEqual(aliceSees.data.leads.map((l: any) => l.lead_id), [aliceLead.id]);
  assert.deepEqual(bobSees.data.leads.map((l: any) => l.lead_id), [bobLead.id]);

  const crossed = await callTool(asAlice, "get_lead", { lead_id: bobLead.id });
  assert.equal(crossed.data.error.code, "NOT_FOUND");

  await asAlice.close();
  await asBob.close();
});

// ── the code and the keys ────────────────────────────────────────────

test("a code works once, only with its PKCE verifier and return address; a second use ends the sign-in", async () => {
  const customer = await makeCustomer("carol@example.com");
  const id = (await register()).body.client_id;
  const { verifier, challenge } = pkce();
  const page = await fetch(authorizeUrl(id, challenge));
  const allowed = await submit(hiddenRequest(await page.text()), { action: "allow", email: customer.email, password: PASSWORD });
  const location = new URL(allowed.headers.get("location") as string);
  assert.equal(location.searchParams.get("state"), "state-123");
  const code = location.searchParams.get("code") as string;
  const exchange = (extra: Record<string, string>) =>
    tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: id, code_verifier: verifier, ...extra });

  assert.equal((await exchange({ code_verifier: pkce().verifier })).body.error, "invalid_grant", "another verifier");
  assert.equal((await exchange({ redirect_uri: "http://localhost:9999/other" })).body.error, "invalid_grant", "another return address");
  assert.equal((await exchange({ resource: "https://evil.example/mcp" })).body.error, "invalid_target");
  const other = (await register({ client_name: "Other app" })).body.client_id;
  assert.equal((await exchange({ client_id: other })).body.error, "invalid_grant", "another app");

  const ok = await exchange({});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.token_type, "Bearer");
  assert.equal(ok.body.expires_in, 3600);
  assert.equal(ok.body.scope, "touchbase:harness offline_access");
  assert.equal(await mcpStatus(ok.body.access_token), 200);

  const again = await exchange({});
  assert.equal(again.body.error, "invalid_grant");
  assert.equal(await mcpStatus(ok.body.access_token), 401, "a reused code revokes the keys it gave out");

  const stored = JSON.stringify(await prisma.oAuthToken.findMany());
  assert.equal(stored.includes(ok.body.access_token), false, "only hashes are stored");
  assert.equal(stored.includes(ok.body.refresh_token), false);
});

test("an expired code is refused", async () => {
  const customer = await makeCustomer("dave@example.com");
  const id = (await register()).body.client_id;
  const { verifier, challenge } = pkce();
  const page = await fetch(authorizeUrl(id, challenge));
  const allowed = await submit(hiddenRequest(await page.text()), { action: "allow", email: customer.email, password: PASSWORD });
  const code = new URL(allowed.headers.get("location") as string).searchParams.get("code") as string;
  await prisma.oAuthAuthCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

  const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: id, code_verifier: verifier });
  assert.equal(res.body.error, "invalid_grant");
});

test("refresh: the key is replaced each time; using an old one again ends the whole sign-in", async () => {
  const customer = await makeCustomer("erin@example.com");
  const first = await signIn(customer.email);

  const second = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.refresh_token, first.refresh_token);
  assert.notEqual(second.body.access_token, first.access_token);
  assert.equal(await mcpStatus(second.body.access_token), 200);

  // the old refresh key is presented again: someone may have a copy
  const reused = await tokenRequest({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.error, "invalid_grant", "RFC 6749 code, so Claude knows to sign in again");
  assert.equal(await mcpStatus(second.body.access_token), 401, "every key of that sign-in stops working");
  const third = await tokenRequest({ grant_type: "refresh_token", refresh_token: second.body.refresh_token, client_id: first.clientId });
  assert.equal(third.body.error, "invalid_grant");
});

test("keys: refused by the normal API, refused when expired, and ended by revoke or by disconnecting in the app", async () => {
  const customer = await makeCustomer("frank@example.com");
  const stranger = await makeCustomer("grace@example.com");
  const keys = await signIn(customer.email);

  assert.equal((await apiClient(app.url, keys.access_token)("GET", "/leads")).status, 401, "an OAuth key is not a login");
  assert.equal(await mcpStatus(keys.access_token), 200);

  await prisma.oAuthToken.updateMany({ where: { kind: "access" }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${keys.access_token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

  // the app gives the refresh key back
  const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: keys.refresh_token, client_id: keys.clientId });
  assert.equal(await mcpStatus(fresh.body.access_token), 200);
  const revoke = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: fresh.body.refresh_token }).toString() });
  assert.equal(revoke.status, 200);
  assert.equal(await mcpStatus(fresh.body.access_token), 401);

  // the customer disconnects the app in Touchbase
  const again = await signIn(customer.email);
  const api = apiClient(app.url, tokenFor(customer));
  const listed = await api("GET", "/connected-apps");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].clientName, "Test Claude");
  assert.equal(JSON.stringify(listed.body).includes("tb_o"), false, "no key is ever listed");

  const notTheirs = await apiClient(app.url, tokenFor(stranger))("DELETE", `/connected-apps/${listed.body.data[0].id}`);
  assert.equal(notTheirs.status, 404);
  assert.equal(await mcpStatus(again.access_token), 200);

  assert.equal((await api("DELETE", `/connected-apps/${listed.body.data[0].id}`)).status, 200);
  assert.equal(await mcpStatus(again.access_token), 401);
  assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: again.refresh_token, client_id: again.clientId })).body.error, "invalid_grant");
  assert.equal((await api("GET", "/connected-apps")).body.data.length, 0);
});

// ── the sign-in page ─────────────────────────────────────────────────

test("sign-in page: wrong password, Cancel, a changed form, too many tries", async () => {
  const customer = await makeCustomer("heidi@example.com");
  const id = (await register()).body.client_id;
  const page = await fetch(authorizeUrl(id, pkce().challenge));
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  // "no-referrer" makes browsers submit the form with `Origin: null`, which the
  // Origin check refuses; "same-origin" sends the real origin (found on Vercel).
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  const request = hiddenRequest(await page.text());

  const wrong = await submit(request, { action: "allow", email: customer.email, password: "nope" });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong email or password/);
  const unknown = await submit(request, { action: "allow", email: "nobody@example.com", password: PASSWORD });
  assert.equal(unknown.status, 401, "same answer for an unknown email");
  assert.equal(await prisma.oAuthAuthCode.count(), 0);

  const cancel = await submit(request, { action: "deny" });
  assert.equal(cancel.status, 302);
  const denied = new URL(cancel.headers.get("location") as string);
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "state-123");

  const [body, signature] = request.split(".");
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), redirectUri: "https://evil.example/cb" })).toString("base64url");
  const tampered = await submit(`${changed}.${signature}`, { action: "allow", email: customer.email, password: PASSWORD });
  assert.equal(tampered.status, 400, "a changed form is refused");

  for (let i = 0; i < 10; i++) await submit(request, { action: "allow", email: customer.email, password: "nope" });
  const limited = await submit(request, { action: "allow", email: customer.email, password: PASSWORD });
  assert.equal(limited.status, 429, "even the right password waits after 10 wrong tries");
});

test("authorization requests: problems with the app are shown on a page; other problems go back to the app", async () => {
  const id = (await register()).body.client_id;
  const { challenge } = pkce();

  const unknownApp = await fetch(authorizeUrl("tbc_unknown", challenge), { redirect: "manual" });
  assert.equal(unknownApp.status, 400);
  assert.match(await unknownApp.text(), /not known to Touchbase/);

  const elsewhere = await fetch(authorizeUrl(id, challenge, { redirect_uri: "https://evil.example/callback" }), { redirect: "manual" });
  assert.equal(elsewhere.status, 400, "never sent to an address the app did not register");

  const backWith = async (extra: Record<string, string>) => {
    const res = await fetch(authorizeUrl(id, challenge, extra), { redirect: "manual" });
    assert.equal(res.status, 302, JSON.stringify(extra));
    return new URL(res.headers.get("location") as string).searchParams.get("error");
  };
  assert.equal(await backWith({ code_challenge: "" }), "invalid_request", "PKCE is required");
  assert.equal(await backWith({ code_challenge_method: "plain" }), "invalid_request", "only S256");
  assert.equal(await backWith({ response_type: "token" }), "unsupported_response_type");
  assert.equal(await backWith({ scope: "admin" }), "invalid_scope");
  assert.equal(await backWith({ resource: "https://evil.example/mcp" }), "invalid_target");

  // the app name is the app's own text: it is shown escaped
  const sneaky = (await register({ client_name: '<script>alert("x")</script>' })).body.client_id;
  const page = await (await fetch(authorizeUrl(sneaky, challenge))).text();
  assert.equal(page.includes("<script>"), false);
  assert.match(page, /&lt;script&gt;/);
});

test("app registration accepts only safe return addresses and public clients", async () => {
  const ok = await register();
  assert.equal(ok.status, 201);
  assert.match(ok.body.client_id, /^tbc_/);
  assert.equal(ok.body.token_endpoint_auth_method, "none");

  for (const bad of [
    { redirect_uris: ["javascript:alert(1)"] },
    { redirect_uris: ["http://evil.example/callback"] },
    { redirect_uris: ["https://claude.ai/cb#fragment"] },
    { redirect_uris: [] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["password"] },
  ]) {
    const res = await register(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error, "invalid_client_metadata");
  }
});

test("Claude's way of identifying itself (a client metadata URL) works, and is checked", async () => {
  const customer = await makeCustomer("ivan@example.com");
  const metadataUrl = "https://claude.example/oauth/client-metadata.json";
  let fetched = 0;
  setMetadataFetcherForTests(async (url) => {
    fetched++;
    if (url.toString() === metadataUrl) {
      return {
        client_id: metadataUrl,
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost/callback", "http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      };
    }
    return { client_id: "https://somewhere.else/doc", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
  });

  const keys = await signIn(customer.email, metadataUrl);
  assert.equal(await mcpStatus(keys.access_token), 200);
  const grant = await prisma.oAuthGrant.findFirstOrThrow({ where: { userId: customer.id } });
  assert.equal(grant.clientName, "Claude");
  const callsAfterSignIn = fetched;
  await signIn(customer.email, metadataUrl);
  assert.equal(fetched, callsAfterSignIn, "the document is kept for a day, not fetched on every sign-in");

  const { challenge } = pkce();
  const mismatch = await fetch(authorizeUrl("https://claude.example/wrong.json", challenge));
  assert.equal(mismatch.status, 400, "the document must name its own URL");
  const plainHttp = await fetch(authorizeUrl("http://claude.example/meta.json", challenge));
  assert.equal(plainHttp.status, 400, "the URL must be https");

  // the real fetcher refuses an address inside a network (no internet needed: an IP needs no lookup)
  setMetadataFetcherForTests(null);
  for (const inside of ["https://127.0.0.1/meta.json", "https://10.0.0.5/meta.json", "https://169.254.169.254/latest/meta-data"]) {
    const res = await fetch(authorizeUrl(inside, challenge));
    assert.equal(res.status, 400, inside);
  }
});

test("a key made for another server address is refused here (audience check)", async () => {
  const customer = await makeCustomer("judy@example.com");
  const keys = await signIn(customer.email);
  assert.equal(await mcpStatus(keys.access_token), 200);

  // The same key, but its sign-in was for a different MCP address.
  await prisma.oAuthGrant.updateMany({ data: { resource: "https://another-server.example/mcp" } });
  assert.equal(await mcpStatus(keys.access_token), 401);
});

test("a metadata URL inside a private network is refused before anything is fetched", async () => {
  setMetadataFetcherForTests(null); // the real fetcher
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (url.startsWith(base)) return realFetch(input as string, init as RequestInit);
    fetched.push(url);
    return new Response(JSON.stringify({ client_id: url, redirect_uris: ["http://localhost/callback"] }), { status: 200 });
  }) as typeof fetch;

  try {
    const { challenge } = pkce();
    for (const inside of ["https://127.0.0.1/meta.json", "https://10.0.0.5/meta.json", "https://169.254.169.254/latest/meta-data", "https://[::1]/meta.json"]) {
      const res = await realFetch(authorizeUrl(inside, challenge));
      assert.equal(res.status, 400, inside);
    }
    assert.deepEqual(fetched, [], "no request was made to a private address");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── public mode ──────────────────────────────────────────────────────

const rawRequest = (path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.port, path, method: path === "/mcp" ? "POST" : "GET", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(path === "/mcp" ? "{}" : undefined);
  });

const rawFormPost = (path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.port, path, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end("");
  });

test("public mode: answers through a proxy for the public address only, and only over https settings", async () => {
  const PUBLIC = "https://mcp.touchbase.test";

  // local mode: a request that came through a proxy is refused
  assert.equal((await rawRequest("/mcp", { "x-forwarded-for": "203.0.113.9" })).status, 403);

  await withEnv({ MCP_PUBLIC: "true", MCP_PUBLIC_URL: PUBLIC }, async () => {
    const viaProxy = await rawRequest("/mcp", { host: "mcp.touchbase.test", "x-forwarded-for": "203.0.113.9" });
    assert.equal(viaProxy.status, 401, "reaches the key check (asks to sign in)");

    const otherHost = await rawRequest("/mcp", { host: "evil.example" });
    assert.equal(otherHost.status, 403, "a different Host is refused");

    const metadata = JSON.parse((await rawRequest("/.well-known/oauth-authorization-server", { host: "mcp.touchbase.test" })).body);
    assert.equal(metadata.issuer, PUBLIC);
    assert.equal(metadata.authorization_endpoint, `${PUBLIC}/oauth/authorize`);
    const resource = JSON.parse((await rawRequest("/.well-known/oauth-protected-resource/mcp", { host: "mcp.touchbase.test" })).body);
    assert.equal(resource.resource, `${PUBLIC}/mcp`);

    // Submitting the sign-in form: a browser sends the page's own origin
    // (Referrer-Policy "same-origin"). That passes the Origin check and reaches
    // the form handling (400 here, because the form is empty); `Origin: null`
    // and other sites are refused before that.
    const submitForm = (origin: string) => rawFormPost("/oauth/authorize", { host: "mcp.touchbase.test", origin });
    assert.notEqual((await submitForm(PUBLIC)).status, 403, "the page's own origin passes");
    assert.equal((await submitForm("null")).status, 403, "Origin: null is refused");
    assert.equal((await submitForm("https://evil.example")).status, 403, "another site is refused");
  });

  // public mode is refused without an https address
  await withEnv({ MCP_PUBLIC: "true", MCP_PUBLIC_URL: "http://mcp.touchbase.test" }, async () => {
    assert.equal((await rawRequest("/mcp", { host: "mcp.touchbase.test", "x-forwarded-for": "203.0.113.9" })).status, 403);
  });
});

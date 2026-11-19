// Access tokens for Claude: shown once, stored as a hash, accepted only at /mcp.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  apiClient,
  makeAccessToken,
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  startApp,
  tokenFor,
} from "./helpers/setup";
import { TokenService } from "../src/harness/tokens/token.service";
import { LIMITS } from "../src/harness/limits";
import { markLeadDoNotContact } from "../src/harness/do-not-contact";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

const TOKEN_SHAPE = /^tb_pat_[A-Za-z0-9_-]{43}$/;

test("a token is shown once and only its hash is stored", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const before = Date.now();

  const res = await api("POST", "/mcp-tokens", { name: "My laptop" });

  assert.equal(res.status, 201);
  const token: string = res.body.data.token;
  assert.match(token, TOKEN_SHAPE);
  assert.equal(res.body.data.name, "My laptop");
  assert.equal(res.body.data.tokenHash, undefined);

  const rows = await prisma.apiToken.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, createHash("sha256").update(token).digest("hex"));
  assert.equal(rows[0].prefix, token.slice(0, 11));
  assert.equal(JSON.stringify(rows[0]).includes(token), false, "the token itself is not in the database");

  const days = (rows[0].expiresAt!.getTime() - before) / 86_400_000;
  assert.ok(days > 89.9 && days < 90.1, "expires in 90 days by default");
});

test("listing tokens never shows a token or its hash", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const mine = await makeAccessToken(user.id, "Mine");
  await makeAccessToken(other.id, "Someone else's");

  const res = await api("GET", "/mcp-tokens");

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1, "only this user's tokens");
  assert.deepEqual(Object.keys(res.body.data[0]).sort(), [
    "createdAt",
    "expiresAt",
    "id",
    "lastUsedAt",
    "name",
    "prefix",
    "revokedAt",
  ]);
  assert.equal(JSON.stringify(res.body).includes(mine.token), false);
});

test("an access token is refused by the normal API, on every kind of route", async () => {
  const user = await makeUser();
  const { token } = await makeAccessToken(user.id);
  const withAccessToken = apiClient(app.url, token);
  const lead = await makeLead(user.id);
  const sequence = await makeSequence(user.id, lead.id, { status: "draft" });
  await makeStep(sequence.id, { status: "draft", scheduledAt: new Date(Date.now() + 3_600_000) });
  await markLeadDoNotContact({ userId: user.id, leadId: lead.id, source: "mcp" });

  const attempts: [string, string, unknown?][] = [
    ["GET", "/leads"],
    ["GET", "/settings"],
    ["GET", "/runs"],
    ["GET", "/mcp-tokens"],
    // a token cannot make another token
    ["POST", "/mcp-tokens", { name: "Second" }],
    // the human-only actions
    ["PATCH", `/sequences/${sequence.id}`, { status: "active" }],
    ["POST", `/leads/${lead.id}/do-not-contact/clear`, { reason: "let me" }],
    ["PATCH", "/settings", { sendTimezone: "Europe/London", sendWindowEnd: "23:00" }],
  ];

  for (const [method, path, body] of attempts) {
    const res = await withAccessToken(method, path, body);
    assert.equal(res.status, 401, `${method} ${path}`);
  }

  // Not activated by the access token. (It is "cancelled": marking the lead
  // do-not-contact above cancels its open drafts.)
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.status, "cancelled");
  assert.equal(after.approvedByUserId, null);
  assert.equal((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).doNotContact, true);
  assert.equal(await prisma.userSettings.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.apiToken.count({ where: { userId: user.id } }), 1);
});

test("only a live access token is verified", async () => {
  const user = await makeUser();
  const live = await makeAccessToken(user.id, "live");
  const revoked = await makeAccessToken(user.id, "revoked");
  const expired = await makeAccessToken(user.id, "expired");
  await prisma.apiToken.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
  await prisma.apiToken.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const ok = await TokenService.verifyAccessToken(live.token);
  assert.equal(ok?.userId, user.id);
  assert.equal(ok?.tokenId, live.id);

  assert.equal(await TokenService.verifyAccessToken(revoked.token), null);
  assert.equal(await TokenService.verifyAccessToken(expired.token), null);
  assert.equal(await TokenService.verifyAccessToken(tokenFor(user)), null, "a login token is not an access token");
  assert.equal(await TokenService.verifyAccessToken("tb_pat_" + "A".repeat(43)), null, "well-formed but unknown");
  assert.equal(await TokenService.verifyAccessToken(live.token + "x"), null);
  assert.equal(await TokenService.verifyAccessToken(""), null);
  assert.equal(await TokenService.verifyAccessToken(undefined), null);
});

test("a token stops working when its user is deleted", async () => {
  const user = await makeUser();
  const { token } = await makeAccessToken(user.id);
  await prisma.user.delete({ where: { id: user.id } });

  assert.equal(await TokenService.verifyAccessToken(token), null);
});

test("revoking: only your own token, and twice is fine", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  const mine = await makeAccessToken(user.id);
  const theirs = await makeAccessToken(other.id);

  const notMine = await api("DELETE", `/mcp-tokens/${theirs.id}`);
  assert.equal(notMine.status, 404);
  assert.ok(await TokenService.verifyAccessToken(theirs.token), "the other user's token still works");

  const first = await api("DELETE", `/mcp-tokens/${mine.id}`);
  assert.equal(first.status, 200);
  assert.ok(first.body.data.revokedAt);
  assert.equal(await TokenService.verifyAccessToken(mine.token), null);

  const second = await api("DELETE", `/mcp-tokens/${mine.id}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.revokedAt, first.body.data.revokedAt);
});

test("limits: a name is needed, 1 to 365 days, and at most ten live tokens", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));

  for (const bad of [{}, { name: "  " }, { name: "x", expiresInDays: 0 }, { name: "x", expiresInDays: 366 }, { name: "x", expiresInDays: 1.5 }]) {
    const res = await api("POST", "/mcp-tokens", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  const week = await api("POST", "/mcp-tokens", { name: "Short", expiresInDays: 7 });
  assert.equal(week.status, 201);

  for (let i = 1; i < LIMITS.TOKENS_PER_USER; i++) {
    const res = await api("POST", "/mcp-tokens", { name: `Token ${i}` });
    assert.equal(res.status, 201, `token ${i + 1}`);
  }
  const tooMany = await api("POST", "/mcp-tokens", { name: "One too many" });
  assert.equal(tooMany.status, 400);

  // Revoking one makes room again.
  await api("DELETE", `/mcp-tokens/${week.body.data.id}`);
  const again = await api("POST", "/mcp-tokens", { name: "Fits again" });
  assert.equal(again.status, 201);
});

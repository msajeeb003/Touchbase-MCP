import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import {
  ACCESS_TOKEN_SECONDS,
  CODE_SECONDS,
  REFRESH_TOKEN_DAYS,
  resourceUrl,
} from "./config";
import { OAuthError } from "./errors";

/**
 * Sign-in codes and keys (OAuth 2.1 authorization code flow with PKCE).
 *
 *  - code     "tb_oac_…"  10 minutes, used once
 *  - access   "tb_oat_…"  1 hour, sent by the app with every MCP call
 *  - refresh  "tb_ort_…"  30 days, replaced by a new one every time it is used
 *
 * Only SHA-256 hashes are stored. A code or refresh key used a second time is
 * treated as stolen: the whole grant (every key of that sign-in) is revoked.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const ACCESS_PATTERN = /^tb_oat_[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const LAST_USED_WRITE_EVERY_MS = 60_000;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export const looksLikeOAuthAccessToken = (value: string): boolean => ACCESS_PATTERN.test(value);

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const invalidGrant = (description: string) => new OAuthError("invalid_grant", description);

// ── codes ────────────────────────────────────────────────────────────

export const createAuthorizationCode = async (input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}): Promise<string> => {
  const code = newSecret("tb_oac_");
  await prisma.oAuthAuthCode.create({
    data: {
      ...input,
      codeHash: hash(code),
      expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
    },
  });
  return code;
};

const revokeGrant = async (db: Db, grantId: string) => {
  const now = new Date();
  await db.oAuthGrant.updateMany({ where: { id: grantId, revokedAt: null }, data: { revokedAt: now } });
  await db.oAuthToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: now } });
};

const issueTokens = async (db: Db, grantId: string, scope: string) => {
  const access = newSecret("tb_oat_");
  const refresh = newSecret("tb_ort_");
  const now = Date.now();
  await db.oAuthToken.createMany({
    data: [
      { grantId, kind: "access", tokenHash: hash(access), expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000) },
      { grantId, kind: "refresh", tokenHash: hash(refresh), expiresAt: new Date(now + REFRESH_TOKEN_DAYS * 86_400_000) },
    ],
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refresh,
    scope,
  };
};

const pkceMatches = (verifier: string, challenge: string): boolean =>
  VERIFIER_PATTERN.test(verifier) &&
  sameText(createHash("sha256").update(verifier).digest("base64url"), challenge);

/** grant_type=authorization_code. */
export const exchangeCode = async (input: {
  code: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
}) =>
  prisma.$transaction(async (tx) => {
    const stored = await tx.oAuthAuthCode.findUnique({ where: { codeHash: hash(input.code) } });
    if (!stored) throw invalidGrant("The code is not valid.");

    if (stored.usedAt) {
      // A second use means the code leaked: end everything it gave out.
      if (stored.grantId) await revokeGrant(prisma, stored.grantId);
      throw invalidGrant("The code was already used.");
    }
    if (stored.expiresAt.getTime() < Date.now()) throw invalidGrant("The code has expired.");
    if (stored.clientId !== input.clientId) throw invalidGrant("The code was issued to another client.");
    if (stored.redirectUri !== input.redirectUri) throw invalidGrant("redirect_uri does not match.");
    if (!pkceMatches(input.codeVerifier, stored.codeChallenge)) {
      throw invalidGrant("code_verifier does not match the code_challenge.");
    }
    if (input.resource && input.resource !== stored.resource) {
      throw new OAuthError("invalid_target", "resource does not match the sign-in.");
    }

    const claimed = await tx.oAuthAuthCode.updateMany({
      where: { id: stored.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw invalidGrant("The code was already used.");

    const grant = await tx.oAuthGrant.create({
      data: {
        userId: stored.userId,
        clientId: stored.clientId,
        clientName: input.clientName,
        scope: stored.scope,
        resource: stored.resource,
      },
    });
    await tx.oAuthAuthCode.update({ where: { id: stored.id }, data: { grantId: grant.id } });

    return issueTokens(tx, grant.id, stored.scope);
  });

/** grant_type=refresh_token. The refresh key is replaced; the old one stops working. */
export const refreshTokens = async (input: { refreshToken: string; clientId: string; resource?: string }) => {
  const stored = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hash(input.refreshToken) },
    include: { grant: true },
  });
  if (!stored || stored.kind !== "refresh") throw invalidGrant("The refresh token is not valid.");
  if (stored.grant.clientId !== input.clientId) throw invalidGrant("The refresh token was issued to another client.");
  if (stored.grant.revokedAt) throw invalidGrant("Access was revoked. Connect again.");

  if (stored.usedAt || stored.revokedAt) {
    // Used twice: someone else may hold a copy. End the whole sign-in.
    await revokeGrant(prisma, stored.grantId);
    throw invalidGrant("The refresh token was already used. Connect again.");
  }
  if (stored.expiresAt.getTime() < Date.now()) throw invalidGrant("The refresh token has expired. Connect again.");
  if (input.resource && input.resource !== stored.grant.resource) {
    throw new OAuthError("invalid_target", "resource does not match the sign-in.");
  }

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.oAuthToken.updateMany({
      where: { id: stored.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      await revokeGrant(prisma, stored.grantId);
      throw invalidGrant("The refresh token was already used. Connect again.");
    }
    return issueTokens(tx, stored.grantId, stored.grant.scope);
  });
};

export type VerifiedOAuthToken = { userId: string; grantId: string; clientName: string; expiresAt: Date };

/** Checks a key presented at /mcp. Null for anything that is not a live access key for this server. */
export const verifyOAuthAccessToken = async (
  presented: string | null | undefined
): Promise<VerifiedOAuthToken | null> => {
  if (!presented || !looksLikeOAuthAccessToken(presented)) return null;

  const stored = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hash(presented) },
    include: { grant: true },
  });
  if (!stored || stored.kind !== "access" || stored.revokedAt || stored.grant.revokedAt) return null;
  if (stored.expiresAt.getTime() <= Date.now()) return null;
  // Audience: a key issued for another address is not valid here (RFC 8707).
  if (stored.grant.resource !== resourceUrl()) return null;

  const now = Date.now();
  if (!stored.grant.lastUsedAt || now - stored.grant.lastUsedAt.getTime() > LAST_USED_WRITE_EVERY_MS) {
    prisma.oAuthGrant
      .update({ where: { id: stored.grantId }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }

  return {
    userId: stored.grant.userId,
    grantId: stored.grantId,
    clientName: stored.grant.clientName,
    expiresAt: stored.expiresAt,
  };
};

/** RFC 7009. Revoking a refresh key ends the whole sign-in. Unknown keys are ignored. */
export const revokeOAuthToken = async (presented: string): Promise<void> => {
  const stored = await prisma.oAuthToken.findUnique({ where: { tokenHash: hash(presented) } });
  if (!stored) return;
  if (stored.kind === "refresh") {
    await revokeGrant(prisma, stored.grantId);
  } else {
    await prisma.oAuthToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
};

// ── connected apps, for the person in the Touchbase app ──────────────

export const listConnectedApps = async (userId: string) =>
  prisma.oAuthGrant.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, clientName: true, scope: true, createdAt: true, lastUsedAt: true },
  });

/** Disconnects an app. Safe to call twice. Another user's grant looks like a missing one. */
export const disconnectApp = async (userId: string, grantId: string): Promise<boolean> => {
  const grant = await prisma.oAuthGrant.findFirst({ where: { id: grantId, userId }, select: { id: true } });
  if (!grant) return false;
  await revokeGrant(prisma, grant.id);
  return true;
};

import { createHash, randomBytes } from "crypto";
import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { LIMITS } from "../limits";

/**
 * AI harness: access tokens for Claude (stage 1, local).
 *
 * A token lets Claude act for ONE Touchbase user through /mcp, and nowhere else:
 *  - it is shown once, when it is made; only its SHA-256 hash is stored;
 *  - it can be revoked, and it expires (90 days unless said otherwise);
 *  - the normal REST API does not accept it. That API takes the login token
 *    only, which is what keeps "activate", "clear do-not-contact" and
 *    "change the send window" in a person's hands.
 */

export const ACCESS_TOKEN_PREFIX = "tb_pat_";

/** "tb_pat_" followed by 32 random bytes written as 43 URL-safe characters. */
const TOKEN_PATTERN = /^tb_pat_[A-Za-z0-9_-]{43}$/;

/** How many characters of a token are kept in clear, to recognise it in a list. */
const VISIBLE_PREFIX_LENGTH = 11;

const LAST_USED_WRITE_EVERY_MS = 60_000;

export const looksLikeAccessToken = (value: string): boolean =>
  TOKEN_PATTERN.test(value);

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/** The fields that may be shown. The hash is never among them. */
const PUBLIC_FIELDS = {
  id: true,
  name: true,
  prefix: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

const createToken = async (
  userId: string,
  input: { name: string; expiresInDays?: number }
) => {
  const name = input.name.trim().slice(0, LIMITS.TOKEN_NAME_MAX);
  if (!name) {
    throw new AppError(400, "A name is required for the token");
  }

  const days = input.expiresInDays ?? LIMITS.TOKEN_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.TOKEN_MAX_DAYS) {
    throw new AppError(
      400,
      `A token can be valid for 1 to ${LIMITS.TOKEN_MAX_DAYS} days`
    );
  }

  const now = new Date();
  const active = await prisma.apiToken.count({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  if (active >= LIMITS.TOKENS_PER_USER) {
    throw new AppError(
      400,
      `You already have ${LIMITS.TOKENS_PER_USER} active tokens. Revoke one first.`
    );
  }

  const token = ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");

  const record = await prisma.apiToken.create({
    data: {
      userId,
      name,
      tokenHash: hashToken(token),
      prefix: token.slice(0, VISIBLE_PREFIX_LENGTH),
      expiresAt: new Date(now.getTime() + days * 86_400_000),
    },
    select: PUBLIC_FIELDS,
  });

  // `token` is returned here and never again. It is not stored anywhere.
  return { ...record, token };
};

const listTokens = async (userId: string) =>
  prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: PUBLIC_FIELDS,
  });

/** Revoking twice is fine: the second call changes nothing. */
const revokeToken = async (userId: string, tokenId: string) => {
  const existing = await prisma.apiToken.findFirst({
    where: { id: tokenId, userId },
    select: { id: true, revokedAt: true },
  });

  if (!existing) {
    throw new AppError(404, "Token not found");
  }

  if (existing.revokedAt) {
    return prisma.apiToken.findUniqueOrThrow({
      where: { id: tokenId },
      select: PUBLIC_FIELDS,
    });
  }

  return prisma.apiToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
    select: PUBLIC_FIELDS,
  });
};

export type VerifiedToken = {
  tokenId: string;
  userId: string;
  prefix: string;
  expiresAt: Date | null;
};

/**
 * Checks a token presented at /mcp. Returns null for anything that is not a
 * live access token: wrong shape (for example a login token), unknown,
 * revoked, expired, or belonging to a user that no longer exists.
 */
const verifyAccessToken = async (
  presented: string | undefined | null
): Promise<VerifiedToken | null> => {
  if (!presented || !looksLikeAccessToken(presented)) return null;

  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(presented) },
    select: {
      id: true,
      userId: true,
      prefix: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });

  if (!record || record.revokedAt) return null;

  const now = Date.now();
  if (record.expiresAt && record.expiresAt.getTime() <= now) return null;

  if (
    !record.lastUsedAt ||
    now - record.lastUsedAt.getTime() > LAST_USED_WRITE_EVERY_MS
  ) {
    prisma.apiToken
      .update({ where: { id: record.id }, data: { lastUsedAt: new Date(now) } })
      .catch(() => {});
  }

  return {
    tokenId: record.id,
    userId: record.userId,
    prefix: record.prefix,
    expiresAt: record.expiresAt,
  };
};

export const TokenService = {
  createToken,
  listTokens,
  revokeToken,
  verifyAccessToken,
};

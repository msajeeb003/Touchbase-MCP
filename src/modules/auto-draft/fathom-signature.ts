import crypto from "crypto";
import AppError from "../../shared/errors/AppError";

/**
 * Fathom signs webhooks following the Standard Webhooks spec:
 *   signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   signature      = base64( HMAC-SHA256(secret bytes, signed content) )
 * The `webhook-signature` header holds one or more space-separated `v1,<base64>` entries.
 * The secret is `whsec_<base64>`; the bytes after the prefix are the HMAC key.
 */

const SIGNATURE_VERSION = "v1";
const SECRET_PREFIX = "whsec_";
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type WebhookSignatureHeaders = {
  id?: string;
  timestamp?: string;
  signature?: string;
};

const headerValue = (value: unknown): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
};

export const readSignatureHeaders = (
  headers: Record<string, unknown>
): WebhookSignatureHeaders => ({
  id: headerValue(headers["webhook-id"]),
  timestamp: headerValue(headers["webhook-timestamp"]),
  signature: headerValue(headers["webhook-signature"]),
});

const decodeSecret = (secret: string): Buffer => {
  const encoded = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  return Buffer.from(encoded, "base64");
};

const parseProvidedSignatures = (header: string): Buffer[] =>
  header
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(","))
    .filter(([version]) => version === SIGNATURE_VERSION)
    .map(([, encoded]) => Buffer.from(encoded ?? "", "base64"));

export const verifyFathomSignature = (params: {
  secret: string;
  rawBody: Buffer;
  headers: WebhookSignatureHeaders;
  toleranceSeconds?: number;
}): void => {
  const { secret, rawBody, headers } = params;
  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const { id, timestamp, signature } = headers;

  if (!id || !timestamp || !signature) {
    throw new AppError(401, "Missing webhook signature headers");
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    throw new AppError(401, "Invalid webhook timestamp");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - sentAt) > tolerance) {
    throw new AppError(401, "Webhook timestamp outside allowed tolerance");
  }

  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    rawBody,
  ]);

  const expected = crypto
    .createHmac("sha256", decodeSecret(secret))
    .update(signedContent)
    .digest();

  const matches = parseProvidedSignatures(signature).some(
    (provided) =>
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected)
  );

  if (!matches) {
    throw new AppError(401, "Invalid webhook signature");
  }
};

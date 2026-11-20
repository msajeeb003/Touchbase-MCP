import { createHmac, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { decrypt } from "../../shared/utils/encryption";
import {
  blockPhoneAsOptOut,
  LEAD_OPT_OUT,
  markLeadDoNotContact,
  normalizePhoneNumber,
} from "../../harness/do-not-contact";
import { pauseActiveSequencesForLead } from "../../harness/pause";

/**
 * Inbound SMS from Twilio (a lead texts back).
 *
 * Twilio posts the message to this route (application/x-www-form-urlencoded).
 * The workspace is found by the number the message was sent TO, and the
 * request is accepted only when its X-Twilio-Signature matches, computed with
 * that workspace's own Twilio auth token. Anything else is refused with 403
 * and nothing is stored.
 *
 *  - The reply is stored next to email replies (lead_inbound_emails, channel "sms").
 *  - STOP, UNSUBSCRIBE, CANCEL, END or QUIT: the number is marked do-not-contact
 *    with source "lead_opt_out" (also when it is not a lead yet). START does not clear it.
 *  - Any other reply pauses the lead's running sequences, same as an email reply.
 *
 * TextMagic is not supported: it publishes no way to verify its callbacks.
 */

export const OPT_OUT_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const MAX_SMS_BODY = 2_000;

/** True when the whole message is one opt-out word (any capitals, trailing punctuation allowed). */
export const isOptOutMessage = (body: string): boolean =>
  OPT_OUT_WORDS.has(body.trim().replace(/[.!\s]+$/g, "").toUpperCase());

/**
 * Twilio's signature: base64 HMAC-SHA1, keyed with the auth token, of the full
 * URL followed by every POST field name and value, sorted by name.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export const twilioSignature = (
  authToken: string,
  url: string,
  params: Record<string, unknown>
): string => {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => `${key}${params[key] ?? ""}`)
      .join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
};

export const signatureMatches = (expected: string, given: string | undefined): boolean => {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

type InboundOutcome =
  | { ok: false; status: 403 | 400 }
  | { ok: true; stored: boolean; optOut: boolean; leadId: string | null; pausedSequenceIds: string[] };

/** Finds the workspace this message belongs to and checks the signature. */
const findVerifiedUser = async (
  url: string,
  body: Record<string, string>,
  signature: string | undefined
): Promise<string | null> => {
  const to = normalizePhoneNumber(body.To);
  if (!to || !signature) return null;

  const candidates = await prisma.userSettings.findMany({
    where: { smsProvider: "twilio", twilioPhoneNumber: { not: null }, twilioAuthToken: { not: null } },
    select: { userId: true, twilioPhoneNumber: true, twilioAuthToken: true, twilioAccountSid: true },
  });

  for (const c of candidates) {
    if (normalizePhoneNumber(c.twilioPhoneNumber) !== to) continue;
    if (body.AccountSid && c.twilioAccountSid && body.AccountSid !== c.twilioAccountSid) continue;
    let token: string;
    try {
      token = decrypt(c.twilioAuthToken as string);
    } catch {
      continue;
    }
    if (signatureMatches(twilioSignature(token, url, body), signature)) return c.userId;
  }
  return null;
};

const findLeadByPhone = async (userId: string, phone: string) => {
  const lastDigits = phone.slice(-4);
  const candidates = await prisma.lead.findMany({
    where: { userId, deletedAt: null, phone: { contains: lastDigits } },
    select: { id: true, phone: true },
    orderBy: { createdAt: "asc" },
  });
  return candidates.find((lead) => normalizePhoneNumber(lead.phone) === phone) ?? null;
};

export const processTwilioInboundSms = async (params: {
  url: string;
  body: Record<string, string>;
  signature: string | undefined;
}): Promise<InboundOutcome> => {
  const { body } = params;
  const userId = await findVerifiedUser(params.url, body, params.signature);
  if (!userId) return { ok: false, status: 403 };

  const from = normalizePhoneNumber(body.From);
  const messageSid = (body.MessageSid || body.SmsSid || "").trim();
  if (!from || !messageSid) return { ok: false, status: 400 };

  const text = (body.Body ?? "").toString().slice(0, MAX_SMS_BODY);
  const receivedAt = new Date();
  const lead = await findLeadByPhone(userId, from);

  let stored = false;
  if (lead) {
    try {
      await prisma.leadInboundEmail.create({
        data: {
          userId,
          leadId: lead.id,
          channel: "sms",
          messageId: messageSid,
          fromEmail: null,
          fromPhone: from,
          toEmail: null,
          subject: null,
          bodyText: text,
          receivedAt,
        },
      });
      stored = true;
    } catch (error) {
      // The same message delivered twice: stored once.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    }
  }

  const optOut = isOptOutMessage(text);
  let pausedSequenceIds: string[] = [];

  if (optOut) {
    // The person asked to stop: their own opt-out, which no tool can clear.
    const reason = "The lead replied STOP by SMS";
    await blockPhoneAsOptOut(prisma, userId, from, reason);
    if (lead) {
      const marked = await markLeadDoNotContact({
        userId,
        leadId: lead.id,
        reason,
        source: LEAD_OPT_OUT,
      });
      pausedSequenceIds = marked.pausedSequenceIds;
    }
  } else if (stored && lead) {
    // Same as an email reply: stop the follow-ups until a person looks.
    pausedSequenceIds = await pauseActiveSequencesForLead(lead.id, "lead_replied", {
      onlyIfStartedBefore: receivedAt,
    });
  }

  return { ok: true, stored, optOut, leadId: lead?.id ?? null, pausedSequenceIds };
};

import cron from "node-cron";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Prisma } from "@prisma/client";
import prisma from "../../prisma";
import { SettingsService } from "../../../modules/settings/settings.service";
import {
  INITIAL_SYNC_LOOKBACK_DAYS,
  resolveImapConfig,
} from "./imap-config";
import { normalizeEmail, parseEmailAddress } from "./parse-email-address";
import { pauseActiveSequencesForLead } from "../../../harness/pause";

const POLL_CRON = "*/1 * * * *";
const MAX_BODY_LENGTH = 50_000;

let isProcessing = false;

type MailboxMessage = {
  uid: number;
  source: Buffer;
};

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const buildInitialSinceDate = (): Date => {
  const since = new Date();
  since.setDate(since.getDate() - INITIAL_SYNC_LOOKBACK_DAYS);
  since.setHours(0, 0, 0, 0);
  return since;
};

/**
 * The few mailbox operations the poller uses. The real one is ImapFlow.
 * Tests pass a fake, so no real mailbox is ever opened by a test.
 * There is deliberately no operation here that changes the mailbox.
 */
export interface MailboxClient {
  connect(): Promise<unknown>;
  getMailboxLock(
    path: string,
    options?: { readOnly?: boolean }
  ): Promise<{ release(): void }>;
  search(
    query: { since: Date },
    options: { uid: boolean }
  ): Promise<number[] | false | undefined>;
  fetch(
    range: number[] | string,
    query: { source: true; uid: true }
  ): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<unknown>;
}

export type MailboxClientFactory = (login: {
  host: string;
  port: number;
  user: string;
  pass: string;
}) => MailboxClient;

const createImapClient: MailboxClientFactory = (login) =>
  new ImapFlow({
    host: login.host,
    port: login.port,
    secure: true,
    auth: { user: login.user, pass: login.pass },
    logger: false,
  });

const fetchMessages = async (
  client: MailboxClient,
  lastUid: number
): Promise<MailboxMessage[]> => {
  const messages: MailboxMessage[] = [];

  if (lastUid === 0) {
    const since = buildInitialSinceDate();
    const uids = await client.search({ since }, { uid: true });
    if (!uids || uids.length === 0) return messages;

    for await (const msg of client.fetch(uids, { source: true, uid: true })) {
      if (msg.source) {
        messages.push({ uid: msg.uid, source: msg.source });
      }
    }
    return messages;
  }

  const range = `${lastUid + 1}:*`;
  for await (const msg of client.fetch(range, { source: true, uid: true })) {
    if (msg.uid <= lastUid || !msg.source) continue;
    messages.push({ uid: msg.uid, source: msg.source });
  }

  return messages;
};

const saveInboundEmail = async (params: {
  userId: string;
  leadId: string;
  messageId: string;
  fromEmail: string;
  fromName?: string;
  toEmail?: string;
  subject?: string | null;
  bodyText: string;
  receivedAt: Date;
}): Promise<boolean> => {
  try {
    await prisma.leadInboundEmail.create({ data: params });
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false;
    }
    throw err;
  }
};

const firstAddress = (
  field: { value?: { address?: string; name?: string }[] } | { value?: { address?: string; name?: string }[] }[] | undefined
): { address?: string; name?: string } | undefined => {
  if (!field) return undefined;
  if (Array.isArray(field)) {
    return field[0]?.value?.[0];
  }
  return field.value?.[0];
};

const extractBodyText = (parsed: Awaited<ReturnType<typeof simpleParser>>): string => {
  if (parsed.text?.trim()) return parsed.text.trim();
  const html = parsed.html;
  if (typeof html === "string" && html.trim()) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
};

/** Returns true when the message was a new reply from a lead and was stored. */
const processMailboxMessage = async (
  userId: string,
  mailboxEmail: string,
  message: MailboxMessage
): Promise<boolean> => {
  const parsed = await simpleParser(message.source);
  const fromRaw = firstAddress(parsed.from);
  const from = fromRaw
    ? parseEmailAddress(
        fromRaw.address
          ? fromRaw.name
            ? `${fromRaw.name} <${fromRaw.address}>`
            : fromRaw.address
          : ""
      )
    : null;

  if (!from) return false;

  if (from.email === normalizeEmail(mailboxEmail)) {
    return false;
  }

  const messageId = parsed.messageId?.trim();
  if (!messageId) return false;

  const lead = await prisma.lead.findFirst({
    where: {
      userId,
      deletedAt: null,
      email: { equals: from.email, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (!lead) return false;

  const bodyText = truncate(extractBodyText(parsed), MAX_BODY_LENGTH);

  if (!bodyText) return false;

  const toRaw = firstAddress(parsed.to)?.address;
  const receivedAt = parsed.date ?? new Date();
  const stored = await saveInboundEmail({
    userId,
    leadId: lead.id,
    messageId,
    fromEmail: from.email,
    fromName: from.name,
    toEmail: toRaw ? normalizeEmail(toRaw) : undefined,
    subject: parsed.subject?.trim() || null,
    bodyText,
    receivedAt,
  });

  if (stored) {
    // The lead replied: stop the follow-ups. Every active sequence of this
    // lead is paused, and stays paused until a person resumes it in the app.
    // An email that arrived before a sequence was approved does not count.
    await pauseActiveSequencesForLead(lead.id, "lead_replied", {
      onlyIfStartedBefore: receivedAt,
    });
  }

  return stored;
};

export const pollUserMailbox = async (
  userId: string,
  createClient: MailboxClientFactory = createImapClient
): Promise<void> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { smtpHost: true, smtpUsername: true },
  });

  if (!settings?.smtpHost || !settings.smtpUsername) return;

  const imap = resolveImapConfig(settings.smtpHost);
  if (!imap) {
    console.warn(
      `[LeadEmailReplies] No IMAP mapping for SMTP host "${settings.smtpHost}" (user ${userId})`
    );
    return;
  }

  const password = await SettingsService.getDecryptedField(
    userId,
    "smtpPassword"
  );
  if (!password) return;

  const syncState = await prisma.imapSyncState.upsert({
    where: { userId },
    create: { userId, lastUid: 0 },
    update: {},
    select: { lastUid: true },
  });

  const client = createClient({
    host: imap.host,
    port: imap.port,
    user: settings.smtpUsername,
    pass: password,
  });

  let maxUid = syncState.lastUid;

  try {
    await client.connect();
    // Read-only: the poller can look at the inbox but cannot change it.
    // It does not mark anything as read, move it, or delete it.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });

    try {
      const messages = await fetchMessages(client, syncState.lastUid);
      messages.sort((a, b) => a.uid - b.uid);

      let storedCount = 0;

      for (const message of messages) {
        const stored = await processMailboxMessage(
          userId,
          settings.smtpUsername,
          message
        );
        if (stored) storedCount++;
        maxUid = Math.max(maxUid, message.uid);
      }

      // Counts only. Never log a message, a subject or an address.
      if (messages.length > 0) {
        console.log(
          `[LeadEmailReplies] user ${userId}: ${messages.length} message(s) checked, ${storedCount} lead reply(ies) stored`
        );
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error(`[LeadEmailReplies] IMAP poll failed for user ${userId}:`, err);
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    return;
  }

  if (maxUid > syncState.lastUid) {
    await prisma.imapSyncState.update({
      where: { userId },
      data: { lastUid: maxUid },
    });
  }
};

export const pollInboundEmails = async (): Promise<void> => {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const users = await prisma.userSettings.findMany({
      where: {
        smtpHost: { not: null },
        smtpUsername: { not: null },
        smtpPassword: { not: null },
      },
      select: { userId: true },
    });

    for (const { userId } of users) {
      try {
        await pollUserMailbox(userId);
      } catch (err) {
        console.error(
          `[LeadEmailReplies] Unexpected error for user ${userId}:`,
          err
        );
      }
    }
  } finally {
    isProcessing = false;
  }
};

export const startInboundEmailProcessor = (): void => {
  cron.schedule(POLL_CRON, pollInboundEmails);
  console.log(
    `[LeadEmailReplies] Inbound email processor started (cron "${POLL_CRON}", read-only)`
  );
};

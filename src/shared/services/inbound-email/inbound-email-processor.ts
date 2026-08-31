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

const fetchMessages = async (
  client: ImapFlow,
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

const processMailboxMessage = async (
  userId: string,
  mailboxEmail: string,
  message: MailboxMessage
): Promise<number> => {
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

  if (!from) return message.uid;

  if (from.email === normalizeEmail(mailboxEmail)) {
    return message.uid;
  }

  const messageId = parsed.messageId?.trim();
  if (!messageId) return message.uid;

  const lead = await prisma.lead.findFirst({
    where: {
      userId,
      email: { equals: from.email, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (!lead) return message.uid;

  const bodyText = truncate(extractBodyText(parsed), MAX_BODY_LENGTH);

  if (!bodyText) return message.uid;

  const toRaw = firstAddress(parsed.to)?.address;
  await saveInboundEmail({
    userId,
    leadId: lead.id,
    messageId,
    fromEmail: from.email,
    fromName: from.name,
    toEmail: toRaw ? normalizeEmail(toRaw) : undefined,
    subject: parsed.subject?.trim() || null,
    bodyText,
    receivedAt: parsed.date ?? new Date(),
  });

  return message.uid;
};

const pollUserMailbox = async (userId: string): Promise<void> => {
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

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: {
      user: settings.smtpUsername,
      pass: password,
    },
    logger: false,
  });

  let maxUid = syncState.lastUid;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const messages = await fetchMessages(client, syncState.lastUid);
      messages.sort((a, b) => a.uid - b.uid);
      console.log("messages", messages);

      for (const message of messages) {
        const processedUid = await processMailboxMessage(
          userId,
          settings.smtpUsername,
          message
        );
        maxUid = Math.max(maxUid, processedUid);

        await client.messageFlagsAdd({ uid: message.uid }, ["\\Seen"], {
          uid: true,
        });
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
  console.log("[LeadEmailReplies] Inbound email processor started (every 5 min)");
};

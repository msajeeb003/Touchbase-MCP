// Reply tracking fixes R1, R2, R5, with a fake mailbox. No real mailbox is opened.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  spySenders,
} from "./helpers/setup";
import { encrypt } from "../src/shared/utils/encryption";
import {
  pollUserMailbox,
  type MailboxClient,
} from "../src/shared/services/inbound-email/inbound-email-processor";
import { runSendTick } from "../src/shared/services/send-processor";

beforeEach(resetDb);
after(() => prisma.$disconnect());

const MAILBOX = "owner@example.com";

type FakeMessage = { uid: number; source: Buffer };

const email = (fields: {
  from: string;
  subject: string;
  body: string;
  messageId: string;
  date?: Date;
}): Buffer =>
  Buffer.from(
    [
      `From: ${fields.from}`,
      `To: ${MAILBOX}`,
      `Subject: ${fields.subject}`,
      `Message-ID: <${fields.messageId}>`,
      `Date: ${(fields.date ?? new Date()).toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      fields.body,
      "",
    ].join("\r\n")
  );

/**
 * A mailbox that records everything asked of it. Any operation the poller is
 * not expected to use (for example marking a message as read) is recorded in
 * `unexpected`.
 */
const fakeMailbox = (messages: FakeMessage[]) => {
  const record = {
    logins: [] as { host: string; user: string }[],
    locks: [] as { path: string; options: unknown }[],
    unexpected: [] as string[],
    connected: 0,
    loggedOut: 0,
  };

  const known: MailboxClient = {
    connect: async () => {
      record.connected++;
    },
    getMailboxLock: async (path, options) => {
      record.locks.push({ path, options });
      return { release() {} };
    },
    search: async () => messages.map((m) => m.uid),
    fetch: async function* (range) {
      if (Array.isArray(range)) {
        for (const m of messages) if (range.includes(m.uid)) yield m;
        return;
      }
      // "N:*" — like a real server, always answers with at least the newest message.
      const start = Number(String(range).split(":")[0]);
      const matching = messages.filter((m) => m.uid >= start);
      const answer = matching.length > 0 ? matching : messages.slice(-1);
      for (const m of answer) yield m;
    },
    logout: async () => {
      record.loggedOut++;
    },
  };

  const client = new Proxy(known as unknown as Record<string, unknown>, {
    get(target, property) {
      if (typeof property === "symbol" || property in target) {
        return target[property as string];
      }
      if (property === "then") return undefined;
      return (...args: unknown[]) => {
        record.unexpected.push(`${String(property)}(${JSON.stringify(args)})`);
        return Promise.resolve();
      };
    },
  }) as unknown as MailboxClient;

  const factory = (login: { host: string; port: number; user: string; pass: string }) => {
    record.logins.push({ host: login.host, user: login.user });
    return client;
  };

  return { factory, record };
};

const userWithMailbox = async () => {
  const user = await makeUser();
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      smtpUsername: MAILBOX,
      smtpPassword: encrypt("not-a-real-password"),
    },
  });
  return user;
};

/** Collects everything written to the console while `run` is working. */
const captureConsole = async (run: () => Promise<void>): Promise<string> => {
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const lines: string[] = [];
  const collect = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === "string" ? a : Buffer.isBuffer(a) ? a.toString() : JSON.stringify(a)))
        .join(" ")
    );
  };
  console.log = console.warn = console.error = console.info = collect;
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
};

const waitForActivity = async (sequenceId: string) => {
  for (let i = 0; i < 40; i++) {
    const rows = await prisma.sequenceActivity.findMany({ where: { sequenceId } });
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
};

test("the mailbox is opened read-only and nothing in it is changed", async () => {
  const user = await userWithMailbox();
  const lead = await makeLead(user.id, { email: "lead.one@example.com" });
  const { factory, record } = fakeMailbox([
    { uid: 1, source: email({ from: "Lead One <lead.one@example.com>", subject: "Re: hello", body: "Yes, let us talk.", messageId: "m1@example.com" }) },
    { uid: 2, source: email({ from: "newsletter@example.org", subject: "Weekly news", body: "Not from a lead.", messageId: "m2@example.org" }) },
    { uid: 3, source: email({ from: MAILBOX, subject: "Note to self", body: "From the owner.", messageId: "m3@example.com" }) },
  ]);

  await pollUserMailbox(user.id, factory);

  assert.deepEqual(record.logins, [{ host: "imap.gmail.com", user: MAILBOX }]);
  assert.deepEqual(record.locks, [{ path: "INBOX", options: { readOnly: true } }]);
  assert.deepEqual(
    record.unexpected,
    [],
    "no message is marked as read, moved, flagged or deleted"
  );
  assert.equal(record.connected, 1);
  assert.equal(record.loggedOut, 1);

  const stored = await prisma.leadInboundEmail.findMany({ where: { userId: user.id } });
  assert.equal(stored.length, 1, "only the message from a lead is stored");
  assert.equal(stored[0].leadId, lead.id);
  assert.equal(stored[0].fromEmail, "lead.one@example.com");
  assert.equal(stored[0].bodyText, "Yes, let us talk.");
});

test("nothing from the mailbox is written to the log: counts only", async () => {
  const user = await userWithMailbox();
  await makeLead(user.id, { email: "lead.two@example.com" });
  const { factory } = fakeMailbox([
    { uid: 1, source: email({ from: "Lead Two <lead.two@example.com>", subject: "SECRET-SUBJECT-123", body: "SECRET-BODY-456 please call me", messageId: "s1@example.com" }) },
    { uid: 2, source: email({ from: "stranger@example.org", subject: "PRIVATE-SUBJECT-789", body: "PRIVATE-BODY-000", messageId: "s2@example.org" }) },
  ]);

  const output = await captureConsole(() => pollUserMailbox(user.id, factory));

  for (const secret of [
    "SECRET-SUBJECT-123",
    "SECRET-BODY-456",
    "PRIVATE-SUBJECT-789",
    "PRIVATE-BODY-000",
    "lead.two@example.com",
    "stranger@example.org",
  ]) {
    assert.equal(output.includes(secret), false, `the log must not contain ${secret}`);
  }
  assert.match(output, /2 message\(s\) checked, 1 lead reply\(ies\) stored/);
});

test("a message seen twice is stored once", async () => {
  const user = await userWithMailbox();
  await makeLead(user.id, { email: "lead.three@example.com" });
  const { factory } = fakeMailbox([
    { uid: 7, source: email({ from: "lead.three@example.com", subject: "Re: hi", body: "Thanks.", messageId: "dup@example.com" }) },
  ]);

  await pollUserMailbox(user.id, factory);
  await pollUserMailbox(user.id, factory); // next poll: the server repeats the newest message
  // Even if the position in the mailbox were lost, the same message is not stored again.
  await prisma.imapSyncState.update({ where: { userId: user.id }, data: { lastUid: 0 } });
  await pollUserMailbox(user.id, factory);

  assert.equal(await prisma.leadInboundEmail.count({ where: { userId: user.id } }), 1);
  assert.equal(
    (await prisma.imapSyncState.findUniqueOrThrow({ where: { userId: user.id } })).lastUid,
    7
  );
});

test("a reply pauses the lead's running sequence, and nothing more is sent", async () => {
  const user = await userWithMailbox();
  const lead = await makeLead(user.id, { email: "lead.four@example.com", status: "Active" });
  const otherLead = await makeLead(user.id, { email: "lead.five@example.com" });
  const running = await makeSequence(user.id, lead.id, {
    status: "active",
    approvedAt: new Date(Date.now() - 3_600_000),
  });
  const dueStep = await makeStep(running.id);
  const draft = await makeSequence(user.id, lead.id, { status: "draft" });
  const othersRunning = await makeSequence(user.id, otherLead.id, { status: "active" });
  const { factory } = fakeMailbox([
    { uid: 1, source: email({ from: "lead.four@example.com", subject: "Re: follow-up", body: "Got it, thanks. Talk next week.", messageId: "r1@example.com" }) },
  ]);

  await pollUserMailbox(user.id, factory);

  const paused = await prisma.sequence.findUniqueOrThrow({ where: { id: running.id } });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedReason, "lead_replied");
  assert.ok(paused.pausedAt);

  assert.equal((await prisma.sequence.findUniqueOrThrow({ where: { id: draft.id } })).status, "draft");
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: othersRunning.id } })).status,
    "active",
    "another lead's sequence keeps running"
  );
  assert.equal(
    (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status,
    "Not Active"
  );

  const activity = await waitForActivity(running.id);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].eventType, "sequence_status_changed");
  assert.equal(activity[0].actor, "system");
  assert.deepEqual(activity[0].meta, { from: "active", to: "paused", reason: "lead_replied" });

  // The step that was due does not go out.
  const { senders, calls } = spySenders();
  await runSendTick({ senders });
  assert.equal(calls.filter((c) => c.to === "lead.four@example.com").length, 0);
  assert.equal(
    (await prisma.sequenceStep.findUniqueOrThrow({ where: { id: dueStep.id } })).status,
    "scheduled"
  );
});

test("an email that arrived before the sequence was approved does not pause it", async () => {
  const user = await userWithMailbox();
  const lead = await makeLead(user.id, { email: "lead.six@example.com" });
  const running = await makeSequence(user.id, lead.id, {
    status: "active",
    approvedAt: new Date(),
  });
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const { factory } = fakeMailbox([
    { uid: 1, source: email({ from: "lead.six@example.com", subject: "Old question", body: "Sent before any follow-up.", messageId: "old@example.com", date: twoDaysAgo }) },
  ]);

  await pollUserMailbox(user.id, factory);

  assert.equal(await prisma.leadInboundEmail.count({ where: { userId: user.id } }), 1);
  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: running.id } })).status,
    "active"
  );
});

test("a user without mailbox settings is skipped without opening anything", async () => {
  const user = await makeUser();
  const { factory, record } = fakeMailbox([]);

  await pollUserMailbox(user.id, factory);

  assert.equal(record.logins.length, 0);
  assert.equal(record.connected, 0);
});

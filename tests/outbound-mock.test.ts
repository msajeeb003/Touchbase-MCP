// S3b: with OUTBOUND_MODE=mock (the default) the four adapters make no network call.
//
// A network spy replaces every way out of the process that the adapters use:
// global fetch (Twilio, TextMagic, Retell), nodemailer's transport (SMTP), and
// the raw socket connect underneath both. The spy never lets a call through,
// so this test cannot send anything even when it switches to "live" to prove
// that the spy works.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import nodemailer from "nodemailer";
import { makeUser, prisma, resetDb, withEnv } from "./helpers/setup";
import { encrypt } from "../src/shared/utils/encryption";
import { sendEmail } from "../src/shared/services/email.service";
import { sendSms } from "../src/shared/services/sms.service";
import { sendWhatsApp } from "../src/shared/services/whatsapp.service";
import { triggerCall } from "../src/shared/services/calling.service";

const outbound: string[] = [];

const realFetch = globalThis.fetch;
const realCreateTransport = nodemailer.createTransport;
const realSocketConnect = net.Socket.prototype.connect;

before(async () => {
  await prisma.$queryRaw`SELECT 1`; // open the database connection before the spy goes in

  globalThis.fetch = (async (input: unknown) => {
    outbound.push(`fetch ${String(input)}`);
    throw new Error("blocked by the test network spy");
  }) as typeof fetch;

  (nodemailer as { createTransport: unknown }).createTransport = () => {
    outbound.push("smtp createTransport");
    return {
      sendMail: async () => {
        outbound.push("smtp sendMail");
        throw new Error("blocked by the test network spy");
      },
    };
  };

  (net.Socket.prototype as { connect: unknown }).connect = function () {
    outbound.push("socket connect");
    throw new Error("blocked by the test network spy");
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  (nodemailer as { createTransport: unknown }).createTransport = realCreateTransport;
  (net.Socket.prototype as { connect: unknown }).connect = realSocketConnect;
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  outbound.length = 0;
});

/** A user with every provider filled in, so that only the mode decides. */
const userWithAllProviders = async () => {
  const user = await makeUser();
  const fake = encrypt("not-a-real-secret");
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      // A local address on a port nothing listens on: even if a spy were
      // missing, nothing could leave this machine.
      smtpHost: "127.0.0.1",
      smtpPort: 9,
      smtpUsername: "sender@example.com",
      smtpPassword: fake,
      smsProvider: "twilio",
      twilioAccountSid: "ACtest",
      twilioAuthToken: fake,
      twilioPhoneNumber: "+15550100000",
      twilioWhatsappNumber: "+15550100009",
      retellApiKey: fake,
      retellAgentId: "agent_test",
      retellCallerNumber: "+15550100008",
    },
  });
  return user;
};

const callAllFour = async (userId: string) => {
  const results: unknown[] = [];
  const errors: string[] = [];
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      results.push(await run());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };

  await attempt(() =>
    sendEmail(userId, { to: "lead@example.com", subject: "Hello", text: "Test" })
  );
  await attempt(() => sendSms(userId, "+15550100001", "Test"));
  await attempt(() => sendWhatsApp(userId, "+15550100001", "Test"));
  await attempt(() =>
    triggerCall({
      userId,
      stepId: "step",
      sequenceId: "sequence",
      phone: "+15550100001",
      agentPrompt: "Test",
    })
  );

  return { results, errors };
};

test("mock mode (default): email, SMS, WhatsApp and call make zero outbound calls", async () => {
  const user = await userWithAllProviders();

  const { results, errors } = await withEnv({ OUTBOUND_MODE: undefined }, () =>
    callAllFour(user.id)
  );

  assert.deepEqual(outbound, [], "the network spy must see nothing");
  assert.deepEqual(errors, []);
  assert.equal(results.length, 4);
  assert.deepEqual(results[0], { deliveryMode: "mock" });
  assert.deepEqual(results[1], { deliveryMode: "mock" });
  assert.equal((results[2] as { mock?: boolean }).mock, true);
  assert.equal((results[3] as { mock?: boolean }).mock, true);
});

test("mock mode also holds when OUTBOUND_MODE has an unknown value", async () => {
  const user = await userWithAllProviders();

  for (const value of ["", "mock", "on", "true", "production", "lives"]) {
    outbound.length = 0;
    await withEnv({ OUTBOUND_MODE: value }, () => callAllFour(user.id));
    assert.deepEqual(outbound, [], `OUTBOUND_MODE="${value}"`);
  }
});

test("control: the spy does catch all four adapters when the mode is live", async () => {
  const user = await userWithAllProviders();

  const { results } = await withEnv({ OUTBOUND_MODE: "live" }, () =>
    callAllFour(user.id)
  );

  assert.equal(results.length, 0, "every live attempt was stopped by the spy");
  assert.ok(outbound.includes("smtp createTransport"), "email reached the SMTP layer");
  const fetches = outbound.filter((line) => line.startsWith("fetch "));
  assert.equal(fetches.length, 3, "SMS, WhatsApp and call each tried one HTTP request");
  assert.ok(fetches.some((line) => line.includes("api.twilio.com")));
  assert.ok(fetches.some((line) => line.includes("api.retellai.com")));
});

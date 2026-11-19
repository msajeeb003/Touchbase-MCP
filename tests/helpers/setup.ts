// Shared helpers for the tests. Synthetic data only: every address is on example.com.
import "../../src/config"; // loads .env (JWT secret, encryption key); DATABASE_URL is set by tests/run.cjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import prisma from "../../src/shared/prisma";
import { generateToken } from "../../src/modules/auth/auth.utils";
import type { Senders } from "../../src/shared/services/send-processor";
import { TokenService } from "../../src/harness/tokens/token.service";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export { prisma };

/** Stops at once if the tests are not connected to the local test database. */
export const assertTestDatabase = async (): Promise<void> => {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://missing/missing");
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "tests must use a local database"
  );
  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  assert.equal(rows[0].db, "touchbase_test", "tests must use the touchbase_test database");
};

/** Empties the test database. Refuses to run anywhere else. */
export const resetDb = async (): Promise<void> => {
  await assertTestDatabase();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
  // Registered sign-in apps belong to no user, so the line above keeps them.
  // Clear them too, or a saved app (for example a client metadata document
  // cached by an earlier run) leaks into later tests.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "oauth_clients" CASCADE');
};

export const makeUser = async () =>
  prisma.user.create({
    data: {
      email: `user-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    },
  });

export const makeLead = async (
  userId: string,
  overrides: Record<string, unknown> = {}
) =>
  prisma.lead.create({
    data: {
      userId,
      name: "Test Lead",
      email: `lead-${randomUUID()}@example.com`,
      phone: "+15550100001",
      ...overrides,
    },
  });

/** A run (one instruction typed in Claude) for this user. */
export const makeRun = async (
  userId: string,
  overrides: Record<string, unknown> = {}
) =>
  prisma.agentRun.create({
    data: { userId, instruction: "Test instruction", ...overrides },
  });

/** An access token for this user. Returns the token itself (shown once) and its id. */
export const makeAccessToken = async (userId: string, name = "Test token") => {
  const created = await TokenService.createToken(userId, { name });
  return { token: created.token, id: created.id };
};

export const makeSequence = async (
  userId: string,
  leadId: string,
  overrides: Record<string, unknown> = {}
) => {
  // A sequence "made through the harness" points at a run. Make that run if
  // the test only gave an id.
  if (typeof overrides.runId === "string") {
    await prisma.agentRun.upsert({
      where: { id: overrides.runId },
      create: { id: overrides.runId, userId, instruction: "Test instruction" },
      update: {},
    });
  }

  return prisma.sequence.create({
    data: {
      userId,
      leadId,
      name: "Test sequence",
      totalSteps: 1,
      status: "active",
      ...overrides,
    },
  });
};

export const makeStep = async (
  sequenceId: string,
  overrides: Record<string, unknown> = {}
) =>
  prisma.sequenceStep.create({
    data: {
      sequenceId,
      stepOrder: 1,
      stepType: "EMAIL",
      subject: "Hello",
      content: "Hi, this is a test message.",
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 60_000),
      ...overrides,
    },
  });

export const tokenFor = (user: { id: string; email: string }): string =>
  generateToken({ userId: user.id, email: user.email });

/** Starts the real Express app on a free local port. */
export const startApp = async () => {
  const { default: app } = await import("../../src/app");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    port,
    url: `http://127.0.0.1:${port}/api/v1`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * Connects the SDK's own MCP client to the local app, the way Claude does.
 * `modern: true` uses the 2026-07-28 protocol revision; the default is the
 * older handshake that most clients still use.
 */
export const connectMcp = async (
  mcpUrl: string,
  token: string,
  options: { modern?: boolean } = {}
) => {
  const client = new Client(
    { name: "touchbase-tests", version: "1.0.0" },
    options.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined
  );
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
};

/** The structured part of a tool answer, and whether it was an error. */
export const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; data: any; text: string }> => {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
  };
  const text = result.content?.find((part) => part.type === "text")?.text ?? "";
  return { isError: result.isError === true, data: result.structuredContent ?? null, text };
};

export type ApiResult = { status: number; body: any };

/** A tiny client for the local app. */
export const apiClient =
  (baseUrl: string, token?: string) =>
  async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<ApiResult> => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };

/**
 * A ready-to-use session, the way Claude has one: a user, an access token, a
 * connected client and a started run. `write` adds the run_id for you.
 */
export const startSession = async (mcpUrl: string, instruction = "Test instruction") => {
  const user = await makeUser();
  const { token } = await makeAccessToken(user.id);
  const client = await connectMcp(mcpUrl, token);
  const started = await callTool(client, "start_run", { instruction });
  const runId = started.data.run_id as string;

  return {
    user,
    token,
    client,
    runId,
    api: apiClient(mcpUrl.replace(/\/mcp$/, "/api/v1"), tokenFor(user)),
    call: (name: string, args: Record<string, unknown> = {}) => callTool(client, name, args),
    write: (name: string, args: Record<string, unknown> = {}) =>
      callTool(client, name, { run_id: runId, ...args }),
    close: () => client.close(),
  };
};

/** Everything in a tool answer that is NOT inside an `untrusted…` field, as text. */
export const outsideUntrusted = (value: unknown): string =>
  JSON.stringify(value, (key, v) => (key.startsWith("untrusted") ? undefined : v)) ?? "";

/** Fake provider calls that only count. Nothing real is contacted. */
export const spySenders = (options: { delayMs?: number } = {}) => {
  const calls: { channel: string; to: string; text: string }[] = [];
  const wait = () =>
    new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 0));

  const senders: Senders = {
    sendEmail: async (_userId, email) => {
      calls.push({ channel: "EMAIL", to: email.to, text: email.text });
      await wait();
      return { deliveryMode: "live" };
    },
    sendSms: async (_userId, phone, text) => {
      calls.push({ channel: "SMS", to: phone, text });
      await wait();
      return { deliveryMode: "live" };
    },
    sendWhatsApp: async (_userId, phone, text) => {
      calls.push({ channel: "WHATSAPP", to: phone, text });
      await wait();
      return { sid: "SM-test", status: "queued", mode: "immediate" };
    },
    triggerCall: async (params) => {
      calls.push({ channel: "CALL", to: params.phone, text: params.agentPrompt });
      await wait();
      return { callId: "call-test" };
    },
  };

  return { senders, calls };
};

/** Sets environment switches for one test and puts the old values back after. */
export const withEnv = async <T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T> | T
): Promise<T> => {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

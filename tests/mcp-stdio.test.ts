// The stdio launcher (for the Claude desktop app), started as a real child
// process and driven with the SDK's own stdio client.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { callTool, makeAccessToken, makeUser, prisma, resetDb } from "./helpers/setup";

beforeEach(resetDb);
after(() => prisma.$disconnect());

const root = path.join(__dirname, "..");
const launcher = [
  path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
  path.join(root, "src", "mcp", "stdio.ts"),
];

/** The environment the child gets: this process's, as plain strings. */
const childEnv = (extra: Record<string, string | undefined>) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
};

test("the stdio server starts from any folder, lists the tools and runs one", async () => {
  const user = await makeUser();
  const { token } = await makeAccessToken(user.id);
  const stderr: string[] = [];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: launcher,
    // Started from the temp folder on purpose: the Claude app picks the folder, not us.
    cwd: os.tmpdir(),
    env: childEnv({ TOUCHBASE_MCP_TOKEN: token }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

  const client = new Client({ name: "touchbase-stdio-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(tools.length, 37);
    for (const name of ["start_run", "write_steps", "request_approval", "finish_run"]) {
      assert.ok(tools.includes(name), name);
    }
    assert.match(client.getInstructions() ?? "", /start_run/);

    const started = await callTool(client, "start_run", { instruction: "From the desktop app" });
    assert.equal(started.isError, false);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.data.run_id } });
    assert.equal(run.userId, user.id);
    assert.equal(run.clientName, "stdio");
  } finally {
    await client.close();
  }

  // Nothing but protocol messages went to stdout (the client would have failed
  // to connect otherwise); the server's own lines went to stderr.
  assert.ok(stderr.join("").includes("stdio server ready"));
  assert.equal(stderr.join("").includes(token), false, "the token is never printed");
});

test("without a valid token the launcher stops at once and writes nothing to stdout", async () => {
  const user = await makeUser();
  const { token, id } = await makeAccessToken(user.id);
  await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });

  const cases: [string, string | undefined][] = [
    ["no token", undefined],
    ["a made-up token", "tb_pat_" + "C".repeat(43)],
    ["a revoked token", token],
  ];

  for (const [label, value] of cases) {
    const env = childEnv({});
    delete env.TOUCHBASE_MCP_TOKEN;
    if (value) env.TOUCHBASE_MCP_TOKEN = value;

    const result = spawnSync(process.execPath, launcher, {
      cwd: os.tmpdir(),
      env,
      encoding: "utf8",
      input: "",
      timeout: 60_000,
    });

    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", `${label}: stdout must stay empty`);
    assert.match(result.stderr, /TOUCHBASE_MCP_TOKEN/, label);
    if (value) assert.equal(result.stderr.includes(value), false, `${label}: the token is not echoed`);
  }
});

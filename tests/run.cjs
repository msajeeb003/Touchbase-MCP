// Runs the backend tests against the LOCAL test database only.
//
//   node tests/run.cjs                 all test files
//   node tests/run.cjs send-window     only files whose name contains "send-window"
//   node tests/run.cjs proof scenario  files whose name contains any of the words
//
// The whole set takes about ten minutes on a local database.
//
// What it does:
//  1. creates the local database "touchbase_test" if needed and applies the migrations;
//  2. starts Node's built-in test runner with tsx, one file at a time;
//  3. points DATABASE_URL at the test database, so development data is never touched.
//
// The harness switches are blanked first, so every test starts from the
// defaults: OUTBOUND_MODE=mock (nothing is sent anywhere), /mcp off.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { testDatabaseUrl } = require("./helpers/test-db-url.cjs");

const root = path.join(__dirname, "..");
const filters = process.argv.slice(2);

const prepared = spawnSync(
  process.execPath,
  [path.join(__dirname, "helpers", "prepare-test-db.cjs")],
  { cwd: root, stdio: "inherit" },
);
if (prepared.status !== 0) process.exit(prepared.status || 1);

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.ts"))
  .filter((name) => filters.length === 0 || filters.some((word) => name.includes(word)))
  .sort()
  .map((name) => path.join("tests", name));

if (files.length === 0) {
  console.error("No test files found" + (filters.length ? ' for "' + filters.join(" ") + '"' : ""));
  process.exit(1);
}

const env = { ...process.env, DATABASE_URL: testDatabaseUrl(), NODE_ENV: "test" };
// Every switch is set to "" (which reads as "not set"). An empty value that is
// already in the environment is not replaced by the local .env file, so a
// developer's own .env cannot change what the tests see.
for (const name of [
  "OUTBOUND_MODE",
  "ENABLE_SEND_PROCESSOR",
  "ENABLE_PROVIDER_WEBHOOKS",
  "ENABLE_REPLY_TRACKING",
  "ENABLE_MCP",
  "MCP_PUBLIC",
  "MCP_PUBLIC_URL",
  "MCP_ALLOW_RESUME",
  "TOUCHBASE_MCP_TOKEN",
]) {
  env[name] = "";
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { cwd: root, stdio: "inherit", env },
);
process.exit(result.status === null ? 1 : result.status);

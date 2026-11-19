// Creates (if needed) the local test database and applies every migration to it.
// Usage: node tests/helpers/prepare-test-db.cjs
const { spawnSync } = require("child_process");
const path = require("path");
const { testDatabaseUrl, TEST_DB_NAME } = require("./test-db-url.cjs");

const root = path.join(__dirname, "..", "..");
const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"],
  { cwd: root, env: { ...process.env, DATABASE_URL: testDatabaseUrl() }, encoding: "utf8" },
);

const out = (result.stdout || "") + (result.stderr || "");
const lines = out.split(/\r?\n/).filter((l) => /migration|applied|error|database/i.test(l));
console.log(lines.slice(-6).join("\n"));
if (result.status !== 0) {
  console.error("Could not prepare the test database '" + TEST_DB_NAME + "'");
  process.exit(result.status || 1);
}
console.log("Test database '" + TEST_DB_NAME + "' is ready (local only).");

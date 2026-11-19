// Builds the URL of the local TEST database from the local .env.
// Same local server as development, different database name, so tests never
// touch the development data. Refuses anything that is not on this machine.
const fs = require("fs");
const path = require("path");

const TEST_DB_NAME = "touchbase_test";

function testDatabaseUrl() {
  const envPath = path.join(__dirname, "..", "..", ".env");
  const match = /^DATABASE_URL=["']?([^"'\r\n]+)/m.exec(fs.readFileSync(envPath, "utf8"));
  if (!match) throw new Error("DATABASE_URL not found in .env");
  const url = new URL(match[1]);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      "Refusing to run tests: DATABASE_URL in .env is not a local database (" + url.hostname + ")",
    );
  }
  url.pathname = "/" + TEST_DB_NAME;
  return url.toString();
}

module.exports = { testDatabaseUrl, TEST_DB_NAME };

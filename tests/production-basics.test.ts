// Fixes from the production-readiness check: unexpected errors are logged,
// and the lead list cannot be asked for an unbounded or broken page.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  apiClient,
  makeLead,
  makeUser,
  prisma,
  resetDb,
  startApp,
  tokenFor,
} from "./helpers/setup";
import globalErrorHandler from "../src/shared/middleware/globalErrorHandler";
import AppError from "../src/shared/errors/AppError";

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

/** Captures console.error while `run` runs. */
const captureErrors = async <T>(run: () => Promise<T>) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
};

test("an unexpected error is written to the log with the request; an expected one is not", async () => {
  const mini = express();
  mini.get("/boom", () => {
    throw new Error("database is down");
  });
  mini.get("/missing", () => {
    throw new AppError(404, "Lead not found");
  });
  mini.use(globalErrorHandler);
  const server = mini.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const call = apiClient(`http://127.0.0.1:${port}`);

  try {
    const boom = await captureErrors(() => call("GET", "/boom"));
    assert.equal(boom.result.status, 500);
    assert.ok(
      boom.lines.some((l) => l.includes("GET /boom") && l.includes("database is down")),
      "the 500 is in the log with its request and cause"
    );

    const missing = await captureErrors(() => call("GET", "/missing"));
    assert.equal(missing.result.status, 404);
    assert.equal(missing.lines.length, 0, "a normal 404 is not logged as an error");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("GET /leads: page and limit are checked, and a page holds at most 100 leads", async () => {
  const user = await makeUser();
  const api = apiClient(app.url, tokenFor(user));
  for (let i = 0; i < 3; i++) await makeLead(user.id);

  const broken = await api("GET", "/leads?page=abc&limit=xyz");
  assert.equal(broken.status, 200);
  assert.equal(broken.body.data.items.length, 3);
  assert.equal(broken.body.data.pagination.page, 1);
  assert.equal(broken.body.data.pagination.limit, 20);

  const huge = await api("GET", "/leads?limit=100000");
  assert.equal(huge.status, 200);
  assert.equal(huge.body.data.pagination.limit, 100);

  const negative = await api("GET", "/leads?page=-2&limit=0");
  assert.equal(negative.status, 200);
  assert.equal(negative.body.data.pagination.page, 1);
  assert.equal(negative.body.data.pagination.limit, 20);
});

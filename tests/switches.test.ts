// S3a and the other environment switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMockMode,
  outboundMode,
  providerWebhooksEnabled,
  replyTrackingEnabled,
  sendProcessorEnabled,
} from "../src/harness/switches";
import { startBackgroundJobs } from "../src/harness/startup";
import { withEnv } from "./helpers/setup";

const quiet = () => {};

test("OUTBOUND_MODE defaults to mock and is live only when it says exactly live", async () => {
  await withEnv({ OUTBOUND_MODE: undefined }, () => {
    assert.equal(outboundMode(), "mock");
    assert.equal(isMockMode(), true);
  });
  for (const value of ["", "mock", "LIVE ", "Live", "yes", "true", "production"]) {
    await withEnv({ OUTBOUND_MODE: value }, () => {
      const expected = value.trim().toLowerCase() === "live" ? "live" : "mock";
      assert.equal(outboundMode(), expected, `OUTBOUND_MODE="${value}"`);
    });
  }
});

test("send processor: off by default, on with the switch, on in production", async () => {
  await withEnv({ NODE_ENV: "development", ENABLE_SEND_PROCESSOR: undefined }, () =>
    assert.equal(sendProcessorEnabled(), false)
  );
  await withEnv({ NODE_ENV: "development", ENABLE_SEND_PROCESSOR: "false" }, () =>
    assert.equal(sendProcessorEnabled(), false)
  );
  await withEnv({ NODE_ENV: "development", ENABLE_SEND_PROCESSOR: "true" }, () =>
    assert.equal(sendProcessorEnabled(), true)
  );
  await withEnv({ NODE_ENV: "production", ENABLE_SEND_PROCESSOR: undefined }, () =>
    assert.equal(sendProcessorEnabled(), true)
  );
});

test("the server starts the send cron only when the switch allows it", async () => {
  const run = (env: Record<string, string | undefined>) =>
    withEnv(env, () => {
      const started: string[] = [];
      const result = startBackgroundJobs(
        {
          sendProcessor: () => started.push("send"),
          replyTracking: () => started.push("replies"),
        },
        quiet
      );
      return { started, result };
    });

  const off = await run({
    NODE_ENV: "development",
    ENABLE_SEND_PROCESSOR: undefined,
    ENABLE_REPLY_TRACKING: undefined,
    OUTBOUND_MODE: undefined,
  });
  assert.deepEqual(off.started, []);
  assert.equal(off.result.sendProcessor, false);
  assert.equal(off.result.outboundMode, "mock");

  const on = await run({
    NODE_ENV: "development",
    ENABLE_SEND_PROCESSOR: "true",
    ENABLE_REPLY_TRACKING: undefined,
    OUTBOUND_MODE: undefined,
  });
  assert.deepEqual(on.started, ["send"]);

  const production = await run({
    NODE_ENV: "production",
    ENABLE_SEND_PROCESSOR: undefined,
    ENABLE_REPLY_TRACKING: "true",
    OUTBOUND_MODE: "live",
  });
  assert.deepEqual(production.started, ["send", "replies"]);
});

test("production with OUTBOUND_MODE not set to live prints a clear warning", async () => {
  const lines: string[] = [];
  await withEnv(
    { NODE_ENV: "production", OUTBOUND_MODE: undefined, ENABLE_REPLY_TRACKING: undefined },
    () =>
      startBackgroundJobs({ sendProcessor: quiet, replyTracking: quiet }, (line) =>
        lines.push(line)
      )
  );
  assert.ok(lines.some((line) => line.includes("WARNING") && line.includes("NOT being sent")));
});

test("provider webhooks are on unless switched off", async () => {
  await withEnv({ ENABLE_PROVIDER_WEBHOOKS: undefined }, () =>
    assert.equal(providerWebhooksEnabled(), true)
  );
  await withEnv({ ENABLE_PROVIDER_WEBHOOKS: "true" }, () =>
    assert.equal(providerWebhooksEnabled(), true)
  );
  await withEnv({ ENABLE_PROVIDER_WEBHOOKS: "false" }, () =>
    assert.equal(providerWebhooksEnabled(), false)
  );
});

test("reply tracking needs its switch AND live mode", async () => {
  await withEnv({ ENABLE_REPLY_TRACKING: undefined, OUTBOUND_MODE: "live" }, () =>
    assert.equal(replyTrackingEnabled(), false)
  );
  await withEnv({ ENABLE_REPLY_TRACKING: "true", OUTBOUND_MODE: undefined }, () =>
    assert.equal(replyTrackingEnabled(), false, "never in mock mode")
  );
  await withEnv({ ENABLE_REPLY_TRACKING: "true", OUTBOUND_MODE: "mock" }, () =>
    assert.equal(replyTrackingEnabled(), false, "never in mock mode")
  );
  await withEnv({ ENABLE_REPLY_TRACKING: "true", OUTBOUND_MODE: "live" }, () =>
    assert.equal(replyTrackingEnabled(), true)
  );
});

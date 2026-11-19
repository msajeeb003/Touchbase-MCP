// Rule 8: the send window. Pure date maths, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInsideSendWindow,
  isValidTimeZone,
  localParts,
  nextAllowedTime,
  parseTimeOfDay,
  planSendDates,
  resolveSendWindow,
  zonedTimeToUtc,
  type SendWindow,
} from "../src/harness/send-window";

const london: SendWindow = {
  startMinutes: 9 * 60,
  endMinutes: 18 * 60,
  weekends: false,
  timeZone: "Europe/London",
};

const dhaka: SendWindow = { ...london, timeZone: "Asia/Dhaka" };
const newYork: SendWindow = { ...london, timeZone: "America/New_York" };

const utc = (iso: string) => new Date(iso);

test("times of day are parsed strictly", () => {
  assert.equal(parseTimeOfDay("09:00"), 540);
  assert.equal(parseTimeOfDay("18:30"), 1110);
  assert.equal(parseTimeOfDay("00:00"), 0);
  assert.equal(parseTimeOfDay("23:59"), 1439);
  for (const bad of ["9:00", "24:00", "09:60", "9am", "", "09:00:00"]) {
    assert.equal(parseTimeOfDay(bad), null, bad);
  }
});

test("timezone names are checked", () => {
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("Asia/Dhaka"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("inside and outside the window, in the user's own timezone", () => {
  // Wednesday 18 Nov 2026. London is on UTC in November.
  assert.equal(isInsideSendWindow(utc("2026-11-18T09:00:00Z"), london), true);
  assert.equal(isInsideSendWindow(utc("2026-11-18T17:59:00Z"), london), true);
  assert.equal(isInsideSendWindow(utc("2026-11-18T18:00:00Z"), london), false);
  assert.equal(isInsideSendWindow(utc("2026-11-18T08:59:00Z"), london), false);

  // The same instant is 15:00 in Dhaka (UTC+6): inside there.
  assert.equal(isInsideSendWindow(utc("2026-11-18T09:00:00Z"), dhaka), true);
  // 14:00 UTC is 20:00 in Dhaka: outside there, inside in London.
  assert.equal(isInsideSendWindow(utc("2026-11-18T14:00:00Z"), dhaka), false);
  assert.equal(isInsideSendWindow(utc("2026-11-18T14:00:00Z"), london), true);
});

test("weekends are closed unless the user switches them on", () => {
  const saturdayNoon = utc("2026-11-21T12:00:00Z");
  assert.equal(isInsideSendWindow(saturdayNoon, london), false);
  assert.equal(isInsideSendWindow(saturdayNoon, { ...london, weekends: true }), true);
});

test("Friday 23:00 moves to Monday 09:00", () => {
  const fridayNight = utc("2026-11-20T23:00:00Z"); // Friday 23:00 in London
  const next = nextAllowedTime(fridayNight, london);
  assert.equal(next.toISOString(), "2026-11-23T09:00:00.000Z"); // Monday 09:00
});

test("with weekends on, Friday 23:00 moves to Saturday 09:00", () => {
  const next = nextAllowedTime(utc("2026-11-20T23:00:00Z"), { ...london, weekends: true });
  assert.equal(next.toISOString(), "2026-11-21T09:00:00.000Z");
});

test("a time inside the window is not moved; an early morning moves to 09:00 the same day", () => {
  const inside = utc("2026-11-18T10:15:00Z");
  assert.equal(nextAllowedTime(inside, london).getTime(), inside.getTime());
  assert.equal(
    nextAllowedTime(utc("2026-11-18T06:00:00Z"), london).toISOString(),
    "2026-11-18T09:00:00.000Z"
  );
});

test("the window follows the user's timezone, not UTC", () => {
  // 20:00 in Dhaka on Wednesday -> Thursday 09:00 Dhaka = 03:00 UTC
  const next = nextAllowedTime(utc("2026-11-18T14:00:00Z"), dhaka);
  assert.equal(next.toISOString(), "2026-11-19T03:00:00.000Z");
});

test("daylight saving: 09:00 local is the right instant on both sides of a clock change", () => {
  // London: clocks go forward on Sunday 29 Mar 2026, back on Sunday 25 Oct 2026.
  assert.equal(
    zonedTimeToUtc(2026, 3, 27, 9, 0, "Europe/London").toISOString(),
    "2026-03-27T09:00:00.000Z" // Friday before: GMT
  );
  assert.equal(
    zonedTimeToUtc(2026, 3, 30, 9, 0, "Europe/London").toISOString(),
    "2026-03-30T08:00:00.000Z" // Monday after: BST
  );
  assert.equal(
    zonedTimeToUtc(2026, 10, 23, 9, 0, "Europe/London").toISOString(),
    "2026-10-23T08:00:00.000Z" // Friday before: BST
  );
  assert.equal(
    zonedTimeToUtc(2026, 10, 26, 9, 0, "Europe/London").toISOString(),
    "2026-10-26T09:00:00.000Z" // Monday after: GMT
  );

  // New York: forward on 8 Mar 2026, back on 1 Nov 2026.
  assert.equal(
    zonedTimeToUtc(2026, 3, 6, 9, 0, "America/New_York").toISOString(),
    "2026-03-06T14:00:00.000Z"
  );
  assert.equal(
    zonedTimeToUtc(2026, 3, 9, 9, 0, "America/New_York").toISOString(),
    "2026-03-09T13:00:00.000Z"
  );
});

test("daylight saving: a Friday-night approval across the clock change lands on Monday 09:00 local", () => {
  // Friday 27 Mar 2026 23:00 London (GMT). The clocks change on Sunday.
  const next = nextAllowedTime(utc("2026-03-27T23:00:00Z"), london);
  assert.equal(next.toISOString(), "2026-03-30T08:00:00.000Z"); // Monday 09:00 BST
  const local = localParts(next, "Europe/London");
  assert.equal(local.hour, 9);
  assert.equal(local.minute, 0);

  // New York, Friday 30 Oct 2026 20:00 local; clocks go back on Sunday 1 Nov.
  const ny = nextAllowedTime(utc("2026-10-31T00:00:00Z"), newYork);
  assert.equal(ny.toISOString(), "2026-11-02T14:00:00.000Z"); // Monday 09:00 EST
});

test("settings without a timezone are refused with the agreed message; no UTC fallback", () => {
  const result = resolveSendWindow({
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    sendOnWeekends: false,
    sendTimezone: null,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "NO_TIMEZONE");
    assert.equal(
      result.message,
      "Set your timezone in Settings before approving. Messages are only sent between 09:00 and 18:00, Monday to Friday, in your own timezone."
    );
  }

  // A user with no settings row at all is treated the same way.
  const none = resolveSendWindow(null);
  assert.equal(none.ok, false);
});

test("bad settings are refused, good settings give the defaults 09:00-18:00 weekdays", () => {
  const badZone = resolveSendWindow({
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    sendOnWeekends: false,
    sendTimezone: "Mars/Olympus",
  });
  assert.equal(badZone.ok, false);

  const badHours = resolveSendWindow({
    sendWindowStart: "18:00",
    sendWindowEnd: "09:00",
    sendOnWeekends: false,
    sendTimezone: "Europe/London",
  });
  assert.equal(badHours.ok, false);

  const good = resolveSendWindow({
    sendWindowStart: "09:00",
    sendWindowEnd: "18:00",
    sendOnWeekends: false,
    sendTimezone: "Europe/London",
  });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.window, london);
});

test("approval on Friday 23:00: first step Monday 09:00, later steps keep their spacing", () => {
  const now = utc("2026-11-20T23:00:00Z"); // Friday 23:00 London
  const day = 24 * 60;
  const steps = [
    { id: "s1", stepOrder: 1, status: "draft", scheduledAt: now, sentAt: null, delayMinutes: 0 },
    { id: "s2", stepOrder: 2, status: "draft", scheduledAt: now, sentAt: null, delayMinutes: 2 * day },
    { id: "s3", stepOrder: 3, status: "draft", scheduledAt: now, sentAt: null, delayMinutes: 3 * day },
  ];

  const plan = planSendDates(steps, london, now);

  assert.equal(plan.get("s1")?.toISOString(), "2026-11-23T09:00:00.000Z"); // Monday
  assert.equal(plan.get("s2")?.toISOString(), "2026-11-25T09:00:00.000Z"); // Wednesday
  // Wednesday + 3 days = Saturday -> moved to Monday 09:00
  assert.equal(plan.get("s3")?.toISOString(), "2026-11-30T09:00:00.000Z");

  for (const date of plan.values()) {
    assert.equal(isInsideSendWindow(date, london), true);
  }
});

test("resuming: steps already sent are left alone, the next one counts from the last real send", () => {
  const now = utc("2026-11-18T10:00:00Z"); // Wednesday 10:00
  const day = 24 * 60;
  const steps = [
    {
      id: "s1",
      stepOrder: 1,
      status: "sent",
      scheduledAt: utc("2026-11-10T09:00:00Z"),
      sentAt: utc("2026-11-10T09:00:30Z"),
      delayMinutes: 0,
    },
    // Due 2 days after step 1 (long past): goes out now, not in the past.
    { id: "s2", stepOrder: 2, status: "scheduled", scheduledAt: utc("2026-11-12T09:00:00Z"), sentAt: null, delayMinutes: 2 * day },
    { id: "s3", stepOrder: 3, status: "scheduled", scheduledAt: utc("2026-11-14T09:00:00Z"), sentAt: null, delayMinutes: day },
  ];

  const plan = planSendDates(steps, london, now);

  assert.equal(plan.has("s1"), false);
  assert.equal(plan.get("s2")?.toISOString(), now.toISOString());
  assert.equal(plan.get("s3")?.toISOString(), "2026-11-19T10:00:00.000Z");
});

test("two steps are never planned for the same minute", () => {
  const now = utc("2026-11-18T10:00:00Z");
  const steps = [
    { id: "s1", stepOrder: 1, status: "draft", scheduledAt: now, sentAt: null, delayMinutes: 0 },
    { id: "s2", stepOrder: 2, status: "draft", scheduledAt: now, sentAt: null, delayMinutes: 0 },
  ];
  const plan = planSendDates(steps, london, now);
  const first = plan.get("s1")!.getTime();
  const second = plan.get("s2")!.getTime();
  assert.ok(second - first >= 60_000);
});

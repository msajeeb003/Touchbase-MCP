import type { Prisma } from "@prisma/client";
import prisma from "../shared/prisma";

/**
 * AI harness, rule 8: working hours only.
 *
 * Each user has a send window: a start time, an end time, a timezone and
 * "send on weekends". Messages of sequences made through the harness go out
 * only inside it. There is no default timezone and no UTC fallback: until the
 * user sets one, such a sequence cannot be approved.
 *
 * Timezone maths uses the platform's own timezone data (Intl). No package.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export type SendWindow = {
  /** Minutes after local midnight, inclusive. */
  startMinutes: number;
  /** Minutes after local midnight, exclusive. */
  endMinutes: number;
  weekends: boolean;
  /** IANA name, for example "Europe/London". */
  timeZone: string;
};

export type SendWindowSettings = {
  sendWindowStart: string;
  sendWindowEnd: string;
  sendOnWeekends: boolean;
  sendTimezone: string | null;
};

export const DEFAULT_SEND_WINDOW_START = "09:00";
export const DEFAULT_SEND_WINDOW_END = "18:00";

/** Two steps of one sequence are never planned closer together than this. */
const MIN_GAP_MS = 60_000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "09:30" -> 570. Null when the text is not a valid 24-hour time. */
export const parseTimeOfDay = (value: string): number | null => {
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

export const isValidTimeZone = (timeZone: string): boolean => {
  if (!timeZone || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** The wall-clock date and time that `date` shows in `timeZone`. */
export const localParts = (date: Date, timeZone: string): LocalParts => {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
};

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
const offsetMs = (date: Date, timeZone: string): number => {
  const p = localParts(date, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
};

/** The instant at which the wall clock in `timeZone` shows the given date and time. */
export const zonedTimeToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date => {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = wall - offsetMs(new Date(wall), timeZone);
  // Second pass: the offset can differ at the guessed instant near a clock change.
  return new Date(wall - offsetMs(new Date(firstGuess), timeZone));
};

const isWeekend = (year: number, month: number, day: number): boolean => {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
};

export const isInsideSendWindow = (date: Date, window: SendWindow): boolean => {
  const p = localParts(date, window.timeZone);
  if (!window.weekends && isWeekend(p.year, p.month, p.day)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= window.startMinutes && minutes < window.endMinutes;
};

/**
 * `date` itself when it is inside the window, otherwise the next moment the
 * window opens. Friday 23:00 gives Monday at the start time (weekends off).
 */
export const nextAllowedTime = (date: Date, window: SendWindow): Date => {
  if (isInsideSendWindow(date, window)) return date;

  const p = localParts(date, window.timeZone);

  for (let add = 0; add <= 8; add++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const dayOfMonth = day.getUTCDate();

    if (!window.weekends && isWeekend(year, month, dayOfMonth)) continue;

    const opens = zonedTimeToUtc(
      year,
      month,
      dayOfMonth,
      Math.floor(window.startMinutes / 60),
      window.startMinutes % 60,
      window.timeZone
    );

    if (opens.getTime() >= date.getTime()) return opens;
  }

  // Cannot happen with a valid window: some day in the next week is allowed.
  throw new Error("No allowed send time found");
};

const describeWindow = (settings: SendWindowSettings): string =>
  `Messages are only sent between ${settings.sendWindowStart} and ${settings.sendWindowEnd}, ` +
  `${settings.sendOnWeekends ? "every day" : "Monday to Friday"}, in your own timezone.`;

export type SendWindowResult =
  | { ok: true; window: SendWindow }
  | {
      ok: false;
      code: "NO_TIMEZONE" | "BAD_TIMEZONE" | "BAD_HOURS";
      message: string;
    };

/** Turns the stored settings into a usable window, or says exactly what is missing. */
export const resolveSendWindow = (
  settings: SendWindowSettings | null
): SendWindowResult => {
  const effective: SendWindowSettings = settings ?? {
    sendWindowStart: DEFAULT_SEND_WINDOW_START,
    sendWindowEnd: DEFAULT_SEND_WINDOW_END,
    sendOnWeekends: false,
    sendTimezone: null,
  };

  const startMinutes = parseTimeOfDay(effective.sendWindowStart);
  const endMinutes = parseTimeOfDay(effective.sendWindowEnd);

  if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
    return {
      ok: false,
      code: "BAD_HOURS",
      message:
        "Your send hours in Settings are not valid. The start time must be before the end time.",
    };
  }

  if (!effective.sendTimezone || !effective.sendTimezone.trim()) {
    return {
      ok: false,
      code: "NO_TIMEZONE",
      message: `Set your timezone in Settings before approving. ${describeWindow(effective)}`,
    };
  }

  if (!isValidTimeZone(effective.sendTimezone)) {
    return {
      ok: false,
      code: "BAD_TIMEZONE",
      message: `The timezone in Settings ("${effective.sendTimezone}") is not a known timezone. Choose one such as "Europe/London".`,
    };
  }

  return {
    ok: true,
    window: {
      startMinutes,
      endMinutes,
      weekends: effective.sendOnWeekends,
      timeZone: effective.sendTimezone.trim(),
    },
  };
};

export const loadSendWindow = async (
  userId: string,
  db: Db = prisma
): Promise<SendWindowResult> => {
  const settings = await db.userSettings.findUnique({
    where: { userId },
    select: {
      sendWindowStart: true,
      sendWindowEnd: true,
      sendOnWeekends: true,
      sendTimezone: true,
    },
  });

  return resolveSendWindow(settings);
};

export type PlanStep = {
  id: string;
  stepOrder: number;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  /** Delay after the previous step, in minutes. Null means "this exact date". */
  delayMinutes: number | null;
};

const WAITING_STATUSES = new Set(["draft", "scheduled"]);

/**
 * Works out the real send date of every step that has not gone out yet.
 *
 *  - Step 1: `now` plus its delay.
 *  - Each later step: the previous step's real date plus its delay.
 *  - A step without a delay keeps its own date.
 *  - Every date is moved forward into the send window.
 *
 * Returns step id -> date, only for the steps that are still waiting.
 */
export const planSendDates = (
  steps: PlanStep[],
  window: SendWindow,
  now: Date
): Map<string, Date> => {
  const planned = new Map<string, Date>();
  const ordered = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  let previous: Date | null = null;

  for (const step of ordered) {
    if (!WAITING_STATUSES.has(step.status)) {
      previous = step.sentAt ?? step.scheduledAt;
      continue;
    }

    let target: Date;

    if (step.delayMinutes !== null && step.delayMinutes !== undefined) {
      const base: Date = previous ?? now;
      target = new Date(base.getTime() + step.delayMinutes * 60_000);
      if (target.getTime() < now.getTime()) target = now;
    } else {
      target = step.scheduledAt;
    }

    if (previous && target.getTime() < previous.getTime() + MIN_GAP_MS) {
      target = new Date(previous.getTime() + MIN_GAP_MS);
    }

    target = nextAllowedTime(target, window);
    planned.set(step.id, target);
    previous = target;
  }

  return planned;
};

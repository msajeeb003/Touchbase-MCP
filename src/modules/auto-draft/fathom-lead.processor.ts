import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { normalizeEmail } from "../../shared/services/inbound-email/parse-email-address";
import {
  formatFathomTranscript,
  FathomTranscriptItem,
} from "../lead-transcript/lead-transcript.service";
import { FathomMeetingPayload, FathomTranscriptLine } from "./auto-draft.validation";

const LOG_PREFIX = "[AutoDraft]";
const INTERNAL_ONLY = "only_internal";
const LEAD_SOURCE_NOTE = "Source: Fathom";
const TRANSCRIPT_SOURCE = "fathom";
/** Same default as manual create and CSV import (lead.service.ts). */
const DEFAULT_FOLLOW_UP_STAGE = "New";
/** Lines like "Meeting #3: Intro call (2026-09-28)" appended to lead notes. */
const MEETING_LINE_REGEX = /^Meeting #(\d+):/gm;

type LeadRef = { id: string; email: string; notes: string | null };

export type FathomLeadSyncResult = {
  recordingId: number | null;
  isTestEvent: boolean;
  created: string[];
  existing: string[];
  skipped: { email: string | null; reason: string }[];
  transcriptsSaved: string[];
  transcriptsSkipped: { email: string; reason: string }[];
  reason?: string;
};

type ExternalInvitee = { email: string; name: string | null };

type MeetingInfo = {
  recordingId: number | null;
  title: string;
  date: Date | null;
  transcriptText: string;
};

// --- Meeting helpers ---

const nameFromEmail = (email: string): string => email.split("@")[0] || email;

const looksLikeEmail = (value: string): boolean => value.includes("@");

const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toTranscriptItems = (lines: FathomTranscriptLine[] | null | undefined): FathomTranscriptItem[] =>
  (lines ?? [])
    .filter((line) => typeof line.text === "string" && line.text.trim().length > 0)
    .map((line) => ({
      speaker: { display_name: line.speaker?.display_name?.trim() || "Unknown" },
      text: line.text!.trim(),
      timestamp: line.timestamp || "",
    }));

const extractMeetingInfo = (meeting: FathomMeetingPayload): MeetingInfo => ({
  recordingId: meeting.recording_id ?? null,
  title: meeting.title?.trim() || meeting.meeting_title?.trim() || "Fathom meeting",
  date:
    parseDate(meeting.recording_start_time) ??
    parseDate(meeting.scheduled_start_time) ??
    parseDate(meeting.created_at),
  transcriptText: formatFathomTranscript(toTranscriptItems(meeting.transcript)),
});

const meetingLine = (number: number, info: MeetingInfo): string => {
  const day = info.date ? info.date.toISOString().slice(0, 10) : "unknown date";
  return `Meeting #${number}: ${info.title} (${day})`;
};

const nextMeetingNumber = (notes: string | null): number => {
  let max = 0;
  for (const match of (notes ?? "").matchAll(MEETING_LINE_REGEX)) {
    max = Math.max(max, parseInt(match[1], 10));
  }
  return max + 1;
};

// --- Invitees ---

/** External invitees only, excluding the account that recorded the meeting. */
const collectExternalInvitees = (
  meeting: FathomMeetingPayload,
  skipped: FathomLeadSyncResult["skipped"]
): ExternalInvitee[] => {
  const recorderEmail = meeting.recorded_by?.email
    ? normalizeEmail(meeting.recorded_by.email)
    : null;

  const seen = new Set<string>();
  const invitees: ExternalInvitee[] = [];

  for (const invitee of meeting.calendar_invitees ?? []) {
    const rawEmail = invitee.email?.trim();
    if (!rawEmail || !looksLikeEmail(rawEmail)) {
      skipped.push({ email: rawEmail ?? null, reason: "Invitee has no valid email" });
      continue;
    }

    const email = normalizeEmail(rawEmail);

    if (invitee.is_external !== true) {
      skipped.push({ email, reason: "Invitee is not external" });
      continue;
    }
    if (recorderEmail && email === recorderEmail) {
      skipped.push({ email, reason: "Invitee is the recording owner" });
      continue;
    }
    if (seen.has(email)) continue;

    seen.add(email);

    // Fathom sometimes puts the email in `name`; prefer the matched speaker name then.
    const rawName = invitee.name?.trim() || "";
    const name =
      rawName && !looksLikeEmail(rawName)
        ? rawName
        : invitee.matched_speaker_display_name?.trim() || null;

    invitees.push({ email, name });
  }

  return invitees;
};

// --- Leads ---

const findLeadByEmail = (userId: string, email: string) =>
  prisma.lead.findFirst({
    where: { userId, email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, notes: true },
  });

const toLeadRef = (lead: { id: string; email: string | null; notes: string | null }, fallbackEmail: string): LeadRef => ({
  id: lead.id,
  email: lead.email ?? fallbackEmail,
  notes: lead.notes,
});

const createLead = async (
  userId: string,
  invitee: ExternalInvitee,
  info: MeetingInfo
): Promise<{ lead: LeadRef; created: boolean }> => {
  const notes = [LEAD_SOURCE_NOTE, meetingLine(1, info)].join("\n");

  try {
    const lead = await prisma.lead.create({
      data: {
        userId,
        name: invitee.name || nameFromEmail(invitee.email),
        email: invitee.email,
        notes,
        followUpStage: DEFAULT_FOLLOW_UP_STAGE,
      },
      select: { id: true, email: true, notes: true },
    });
    return { lead: toLeadRef(lead, invitee.email), created: true };
  } catch (err) {
    // Unique (userId, email) collision: a concurrent delivery created it first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findLeadByEmail(userId, invitee.email);
      if (existing) return { lead: toLeadRef(existing, invitee.email), created: false };
    }
    throw err;
  }
};

/** Appends "Meeting #N: ..." to an existing lead's notes without touching the rest. */
const appendMeetingToNotes = async (lead: LeadRef, info: MeetingInfo): Promise<void> => {
  const line = meetingLine(nextMeetingNumber(lead.notes), info);
  const notes = lead.notes?.trim() ? `${lead.notes.trimEnd()}\n${line}` : line;

  await prisma.lead.update({ where: { id: lead.id }, data: { notes } });
  lead.notes = notes;
};

// --- Transcripts ---

type TranscriptOutcome = "saved" | "duplicate" | "empty" | "no_date" | "no_recording_id";

const saveTranscript = async (
  userId: string,
  lead: LeadRef,
  info: MeetingInfo
): Promise<TranscriptOutcome> => {
  if (info.recordingId === null) return "no_recording_id";
  if (!info.transcriptText) return "empty";
  if (!info.date) return "no_date";

  const existing = await prisma.leadTranscript.findFirst({
    where: { leadId: lead.id, fathomRecordingId: info.recordingId },
    select: { id: true },
  });
  if (existing) return "duplicate";

  await prisma.leadTranscript.create({
    data: {
      userId,
      leadId: lead.id,
      source: TRANSCRIPT_SOURCE,
      fathomRecordingId: info.recordingId,
      meetingTitle: info.title,
      meetingDate: info.date,
      transcript: info.transcriptText,
    },
  });

  return "saved";
};

// --- Entry point ---

/**
 * For every external invitee: find or create the lead, then store the meeting
 * transcript under it (once per recording). Existing leads get a
 * "Meeting #N" line appended to their notes when a new transcript is saved.
 */
export const syncLeadsFromFathomMeeting = async (
  userId: string,
  meeting: FathomMeetingPayload
): Promise<FathomLeadSyncResult> => {
  const result: FathomLeadSyncResult = {
    recordingId: meeting.recording_id ?? null,
    isTestEvent: meeting.is_test_event === true,
    created: [],
    existing: [],
    skipped: [],
    transcriptsSaved: [],
    transcriptsSkipped: [],
  };

  if (meeting.calendar_invitees_domains_type === INTERNAL_ONLY) {
    result.reason = "Meeting had internal invitees only";
    return result;
  }

  const invitees = collectExternalInvitees(meeting, result.skipped);

  if (invitees.length === 0) {
    result.reason = "No external invitees found";
    return result;
  }

  const info = extractMeetingInfo(meeting);

  for (const invitee of invitees) {
    const found = await findLeadByEmail(userId, invitee.email);
    const { lead, created } = found
      ? { lead: toLeadRef(found, invitee.email), created: false }
      : await createLead(userId, invitee, info);

    (created ? result.created : result.existing).push(lead.email);

    try {
      const outcome = await saveTranscript(userId, lead, info);

      if (outcome === "saved") {
        result.transcriptsSaved.push(lead.email);
        if (!created) await appendMeetingToNotes(lead, info);
      } else {
        result.transcriptsSkipped.push({ email: lead.email, reason: outcome });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.transcriptsSkipped.push({ email: lead.email, reason: `failed: ${message}` });
      console.error(`${LOG_PREFIX} Transcript save failed for lead ${lead.id}:`, err);
    }
  }

  return result;
};

export const logLeadSyncResult = (userId: string, result: FathomLeadSyncResult): void => {
  const summary = {
    userId,
    recordingId: result.recordingId,
    ...(result.isTestEvent && { testEvent: true }),
    created: result.created,
    existing: result.existing,
    skipped: result.skipped,
    transcriptsSaved: result.transcriptsSaved,
    transcriptsSkipped: result.transcriptsSkipped,
    ...(result.reason && { reason: result.reason }),
  };
  console.log(`${LOG_PREFIX} Lead sync finished`, JSON.stringify(summary));
};

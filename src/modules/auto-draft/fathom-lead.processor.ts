import { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";
import { normalizeEmail } from "../../shared/services/inbound-email/parse-email-address";
import { FathomMeetingPayload } from "./auto-draft.validation";

const LOG_PREFIX = "[AutoDraft]";
const INTERNAL_ONLY = "only_internal";
const LEAD_SOURCE_NOTE = "Source: Fathom";

type LeadRef = { id: string; email: string };

export type FathomLeadSyncResult = {
  recordingId: number | null;
  created: LeadRef[];
  existing: LeadRef[];
  skipped: { email: string | null; reason: string }[];
  reason?: string;
};

type ExternalInvitee = { email: string; name: string | null };

const nameFromEmail = (email: string): string => email.split("@")[0] || email;

const meetingTitle = (meeting: FathomMeetingPayload): string =>
  meeting.title?.trim() || meeting.meeting_title?.trim() || "Fathom meeting";

const meetingDate = (meeting: FathomMeetingPayload): string =>
  meeting.recording_start_time || meeting.scheduled_start_time || new Date().toISOString();

const buildNotes = (meeting: FathomMeetingPayload): string =>
  [
    LEAD_SOURCE_NOTE,
    `Meeting: ${meetingTitle(meeting)}`,
    `Date: ${meetingDate(meeting)}`,
    meeting.recording_id != null ? `Recording ID: ${meeting.recording_id}` : null,
  ]
    .filter(Boolean)
    .join("\n");

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
    if (!rawEmail || !rawEmail.includes("@")) {
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
    invitees.push({ email, name: invitee.name?.trim() || null });
  }

  return invitees;
};

const findLeadByEmail = (userId: string, email: string) =>
  prisma.lead.findFirst({
    where: { userId, email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true },
  });

const createLead = async (
  userId: string,
  invitee: ExternalInvitee,
  notes: string
): Promise<{ lead: LeadRef; created: boolean }> => {
  try {
    const lead = await prisma.lead.create({
      data: {
        userId,
        name: invitee.name || nameFromEmail(invitee.email),
        email: invitee.email,
        notes,
      },
      select: { id: true, email: true },
    });
    return { lead: { id: lead.id, email: lead.email ?? invitee.email }, created: true };
  } catch (err) {
    // Unique (userId, email) collision: a concurrent delivery created it first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await findLeadByEmail(userId, invitee.email);
      if (existing) {
        return { lead: { id: existing.id, email: existing.email ?? invitee.email }, created: false };
      }
    }
    throw err;
  }
};

/**
 * Creates a lead for every external invitee of the meeting that is not already a lead.
 * Existing leads are left untouched.
 */
export const syncLeadsFromFathomMeeting = async (
  userId: string,
  meeting: FathomMeetingPayload
): Promise<FathomLeadSyncResult> => {
  const result: FathomLeadSyncResult = {
    recordingId: meeting.recording_id ?? null,
    created: [],
    existing: [],
    skipped: [],
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

  const notes = buildNotes(meeting);

  for (const invitee of invitees) {
    const existing = await findLeadByEmail(userId, invitee.email);

    if (existing) {
      result.existing.push({ id: existing.id, email: existing.email ?? invitee.email });
      continue;
    }

    const { lead, created } = await createLead(userId, invitee, notes);
    (created ? result.created : result.existing).push(lead);
  }

  return result;
};

export const logLeadSyncResult = (userId: string, result: FathomLeadSyncResult): void => {
  const summary = {
    userId,
    recordingId: result.recordingId,
    created: result.created.map((l) => l.email),
    existing: result.existing.map((l) => l.email),
    skipped: result.skipped,
    ...(result.reason && { reason: result.reason }),
  };
  console.log(`${LOG_PREFIX} Lead sync finished`, JSON.stringify(summary));
};

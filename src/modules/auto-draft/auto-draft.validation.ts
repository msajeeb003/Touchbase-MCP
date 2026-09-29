import { z } from "zod";

const inviteeSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  is_external: z.boolean().nullable().optional(),
  matched_speaker_display_name: z.string().nullable().optional(),
});

const transcriptLineSchema = z.object({
  speaker: z
    .object({ display_name: z.string().nullable().optional() })
    .nullable()
    .optional(),
  text: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
});

export type FathomTranscriptLine = z.infer<typeof transcriptLineSchema>;

/**
 * Lenient shape of the meeting object Fathom delivers.
 * Only the fields needed for lead creation are declared; everything else is ignored.
 */
export const fathomMeetingPayloadSchema = z.object({
  recording_id: z.number().int().nullable().optional(),
  title: z.string().nullable().optional(),
  meeting_title: z.string().nullable().optional(),
  recording_start_time: z.string().nullable().optional(),
  scheduled_start_time: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  is_test_event: z.boolean().nullable().optional(),
  calendar_invitees_domains_type: z.string().nullable().optional(),
  recorded_by: z
    .object({
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  calendar_invitees: z.array(inviteeSchema).nullable().optional(),
  transcript: z.array(transcriptLineSchema).nullable().optional(),
});

export type FathomMeetingPayload = z.infer<typeof fathomMeetingPayloadSchema>;

export const unregisterWebhookSchema = z.object({
  body: z.object({
    webhookId: z.string().min(1).optional(),
  }),
});

export type UnregisterWebhookInput = z.infer<typeof unregisterWebhookSchema>["body"];

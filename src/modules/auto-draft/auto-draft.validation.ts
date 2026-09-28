import { z } from "zod";

const inviteeSchema = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  is_external: z.boolean().nullable().optional(),
});

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
  calendar_invitees_domains_type: z.string().nullable().optional(),
  recorded_by: z
    .object({
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  calendar_invitees: z.array(inviteeSchema).nullable().optional(),
});

export type FathomMeetingPayload = z.infer<typeof fathomMeetingPayloadSchema>;

export const unregisterWebhookSchema = z.object({
  body: z.object({
    webhookId: z.string().min(1).optional(),
  }),
});

export type UnregisterWebhookInput = z.infer<typeof unregisterWebhookSchema>["body"];

import { z } from "zod";

export const updateSettingsSchema = z.object({
  body: z.object({
    aiProvider: z.string().nullable().optional(),
    aiApiKey: z.string().nullable().optional(),
    aiModel: z.string().nullable().optional(),

    fathomApiKey: z.string().nullable().optional(),

    smtpHost: z.string().nullable().optional(),
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpUsername: z.string().email("Invalid SMTP email").nullable().optional(),
    smtpPassword: z.string().nullable().optional(),
    smtpFromName: z.string().nullable().optional(),

    textmagicUsername: z.string().nullable().optional(),
    textmagicApiKey: z.string().nullable().optional(),
  }),
});

export type UpdateSettingsInput = z.infer<
  typeof updateSettingsSchema
>["body"];

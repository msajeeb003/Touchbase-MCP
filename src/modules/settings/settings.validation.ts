import { z } from "zod";

export const updateSettingsSchema = z.object({
  body: z.object({
    aiProvider: z.string().optional(),
    aiApiKey: z.string().optional(),
    aiModel: z.string().optional(),

    fathomApiKey: z.string().optional(),

    smtpHost: z.string().optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUsername: z.string().email("Invalid SMTP email").optional(),
    smtpPassword: z.string().optional(),
    smtpFromName: z.string().optional(),

    textmagicUsername: z.string().optional(),
    textmagicApiKey: z.string().optional(),
  }),
});

export type UpdateSettingsInput = z.infer<
  typeof updateSettingsSchema
>["body"];

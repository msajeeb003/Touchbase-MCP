import { z } from "zod";
import { AI_PROVIDER_LIST } from "../../shared/constants";
import { isValidTimeZone } from "../../harness/send-window";

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export const updateSettingsSchema = z.object({
  body: z.object({
    aiProvider: z
      .enum(AI_PROVIDER_LIST as [string, ...string[]], {
        message: `AI provider must be one of: ${AI_PROVIDER_LIST.join(", ")}`,
      })
      .nullable()
      .optional(),
    aiApiKey: z.string().nullable().optional(),
    aiModel: z.string().nullable().optional(),

    fathomApiKey: z.string().nullable().optional(),

    smtpHost: z.string().nullable().optional(),
    smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
    smtpUsername: z.string().email("Invalid SMTP email").nullable().optional(),
    smtpPassword: z.string().nullable().optional(),
    smtpFromName: z.string().nullable().optional(),

    smsProvider: z
      .enum(["textmagic", "twilio"], {
        message: "SMS provider must be one of: textmagic, twilio",
      })
      .nullable()
      .optional(),

    textmagicUsername: z.string().nullable().optional(),
    textmagicApiKey: z.string().nullable().optional(),

    twilioAccountSid: z.string().nullable().optional(),
    twilioAuthToken: z.string().nullable().optional(),
    twilioPhoneNumber: z.string().nullable().optional(),
    twilioWhatsappNumber: z.string().nullable().optional(),

    retellApiKey: z.string().nullable().optional(),
    retellAgentId: z.string().nullable().optional(),
    retellCallerNumber: z.string().nullable().optional(),

    /** Toggling this registers/deletes the Fathom webhook (handled in the controller). */
    autoDraftEnabled: z.boolean().optional(),

    /**
     * Send window (AI harness). Messages of sequences made through the harness
     * go out only between these hours, in this timezone. The service also
     * checks that the start is before the end.
     */
    sendWindowStart: z
      .string()
      .regex(TIME_OF_DAY, "Use a 24-hour time such as 09:00")
      .optional(),
    sendWindowEnd: z
      .string()
      .regex(TIME_OF_DAY, "Use a 24-hour time such as 18:00")
      .optional(),
    sendOnWeekends: z.boolean().optional(),
    sendTimezone: z
      .string()
      .trim()
      .refine(isValidTimeZone, {
        message: 'Unknown timezone. Use a name such as "Europe/London".',
      })
      .nullable()
      .optional(),

    /**
     * What Claude may do in this workspace (AI harness). All off by default.
     * This route takes the login token only: Claude's access tokens are
     * refused here, so Claude can never change these switches.
     */
    claudeCanActivate: z.boolean().optional(),
    claudeCanResume: z.boolean().optional(),
    claudeCanEditSettings: z.boolean().optional(),
    claudeCanDeleteLeads: z.boolean().optional(),
    claudeCanClearDoNotContact: z.boolean().optional(),
    claudeDailyActivationCap: z.number().int().min(0).max(500).optional(),
  }),
});

export type UpdateSettingsInput = z.infer<
  typeof updateSettingsSchema
>["body"];

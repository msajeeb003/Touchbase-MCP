import { z } from "zod";
import { SEQUENCE_STATUS_LIST } from "../../shared/constants";

export const createSequenceSchema = z.object({
  body: z.object({
    leadId: z
      .string({ required_error: "Lead ID is required" })
      .uuid("Invalid Lead ID"),
    promptTemplateId: z
      .string()
      .uuid("Invalid Prompt Template ID")
      .optional(),
    name: z
      .string({ required_error: "Name is required" })
      .min(1, "Name cannot be empty")
      .max(150, "Name must be 150 characters or less"),
    totalSteps: z
      .number({ required_error: "Total steps is required" })
      .int("Total steps must be a whole number")
      .min(1, "Minimum 1 step")
      .max(20, "Maximum 20 steps"),
  }),
});

export const updateSequenceSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(150).optional(),
    status: z
      .enum(SEQUENCE_STATUS_LIST as [string, ...string[]], {
        message: `Status must be one of: ${SEQUENCE_STATUS_LIST.join(", ")}`,
      })
      .optional(),
  }),
});

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>["body"];
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>["body"];

// --- Wizard (generate-save) ---

export const SITUATION_TYPES = [
  "No-show",
  "Post-call follow-up",
  "Demo follow-up",
  "Proposal follow-up",
  "Cold outreach",
  "Re-engagement",
  "Custom",
] as const;

export const GOAL_TYPES = [
  "Book another call",
  "Get a reply",
  "Build relationship",
  "Close the deal",
  "Send proposal",
  "Share resources",
] as const;

export const TONE_TYPES = [
  "Friendly & Professional",
  "Direct & Assertive",
  "Casual & Conversational",
  "Formal & Polished",
] as const;

export const INTENSITY_TYPES = ["Light", "Standard", "Aggressive"] as const;

export const CHANNEL_TYPES = ["email", "sms", "whatsapp", "aicall"] as const;

export type SituationType = (typeof SITUATION_TYPES)[number];
export type GoalType      = (typeof GOAL_TYPES)[number];
export type ToneType      = (typeof TONE_TYPES)[number];
export type IntensityType = (typeof INTENSITY_TYPES)[number];
export type ChannelType   = (typeof CHANNEL_TYPES)[number];

export const CADENCE_REGEX = /^(\d+)\s+steps?\s+over\s+(\d+)\s+days?$/i;

const cadenceSchema = z
  .string({ required_error: "Cadence is required" })
  .refine((v) => CADENCE_REGEX.test(v), {
    message: 'Cadence must match the format "N steps over M days"',
  });

export const generateSaveSchema = z.object({
  body: z
    .object({
      sequenceId: z.string().uuid("Invalid Sequence ID").optional(),
      leadId: z.string({ required_error: "Lead ID is required" }).uuid("Invalid Lead ID"),
      situation: z.object({
        type: z.enum(SITUATION_TYPES, {
          message: `Situation type must be one of: ${SITUATION_TYPES.join(", ")}`,
        }),
        customPrompt: z.string().optional(),
      }),
      goal: z.enum(GOAL_TYPES, {
        message: `Goal must be one of: ${GOAL_TYPES.join(", ")}`,
      }),
      preferences: z.object({
        tone: z.enum(TONE_TYPES, {
          message: `Tone must be one of: ${TONE_TYPES.join(", ")}`,
        }),
        intensity: z.enum(INTENSITY_TYPES, {
          message: `Intensity must be one of: ${INTENSITY_TYPES.join(", ")}`,
        }),
        cadence: cadenceSchema,
        channels: z
          .array(
            z.enum(CHANNEL_TYPES, {
              message: `Each channel must be one of: ${CHANNEL_TYPES.join(", ")}`,
            })
          )
          .min(1, "At least one channel is required")
          .max(4, "Maximum 4 channels"),
      }),
    })
    .superRefine((data, ctx) => {
      if (data.situation.type === "Custom" && !data.situation.customPrompt?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["situation", "customPrompt"],
          message: "customPrompt is required when situation type is 'Custom'",
        });
      }
    }),
});

export type GenerateSaveInput = z.infer<typeof generateSaveSchema>["body"];

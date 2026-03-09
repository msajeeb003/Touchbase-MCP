import { z } from "zod";

const VALID_STEP_TYPES = ["EMAIL", "SMS"] as const;

export const createStepSchema = z.object({
  body: z.object({
    stepOrder: z
      .number({ required_error: "Step order is required" })
      .int("Step order must be a whole number")
      .min(1, "Step order must be at least 1"),
    stepType: z.enum(VALID_STEP_TYPES, {
      required_error: "Step type is required",
      invalid_type_error: "Step type must be EMAIL or SMS",
    }),
    scheduledAt: z
      .string({ required_error: "Scheduled date is required" })
      .datetime("Invalid date format"),
  }),
});

export const updateStepSchema = z.object({
  body: z.object({
    stepType: z.enum(VALID_STEP_TYPES).optional(),
    subject: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    scheduledAt: z.string().datetime("Invalid date format").optional(),
  }),
});

export type CreateStepInput = z.infer<typeof createStepSchema>["body"];
export type UpdateStepInput = z.infer<typeof updateStepSchema>["body"];

import { z } from "zod";

export const createSequenceGoalSchema = z.object({
  body: z.object({
    label: z
      .string({ required_error: "Label is required" })
      .trim()
      .min(1, "Label cannot be empty")
      .max(150, "Label must be 150 characters or less"),
  }),
});

export const updateSequenceGoalSchema = z.object({
  body: z.object({
    label: z
      .string({ required_error: "Label is required" })
      .trim()
      .min(1, "Label cannot be empty")
      .max(150, "Label must be 150 characters or less"),
  }),
});

export type CreateSequenceGoalInput = z.infer<typeof createSequenceGoalSchema>["body"];
export type UpdateSequenceGoalInput = z.infer<typeof updateSequenceGoalSchema>["body"];

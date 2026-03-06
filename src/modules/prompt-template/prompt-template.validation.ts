import { z } from "zod";

export const createPromptTemplateSchema = z.object({
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .min(1, "Name cannot be empty")
      .max(100, "Name must be 100 characters or less"),
    followUpStage: z
      .string({ required_error: "Follow-up stage is required" })
      .min(1, "Follow-up stage cannot be empty")
      .max(50, "Follow-up stage must be 50 characters or less"),
    promptText: z
      .string({ required_error: "Prompt text is required" })
      .min(10, "Prompt text must be at least 10 characters"),
  }),
});

export const updatePromptTemplateSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    followUpStage: z.string().min(1).max(50).optional(),
    promptText: z.string().min(10).optional(),
  }),
});

export type CreatePromptTemplateInput = z.infer<typeof createPromptTemplateSchema>["body"];
export type UpdatePromptTemplateInput = z.infer<typeof updatePromptTemplateSchema>["body"];

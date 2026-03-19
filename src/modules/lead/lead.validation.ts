import { z } from "zod";

export const createLeadSchema = z.object({
  body: z.object({
    name: z.string({ required_error: "Name is required" }).min(1),
    email: z
      .string({ required_error: "Email is required" })
      .email("Invalid email format"),
    phone: z.string({ required_error: "Phone is required" }).min(1),
    company: z.string().optional(),
    location: z.string().optional(),
    status: z.string().optional(),
    followUpStage: z.string({ required_error: "Follow-up stage is required" }).min(1),
  }),
});

export const updateLeadSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    email: z.string().email("Invalid email format").optional(),
    phone: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    status: z.string().optional(),
    followUpStage: z.string().nullable().optional(),
  }),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>["body"];
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>["body"];

import { z } from "zod";

const emptyToUndefined = (val: unknown) =>
  val === "" || val === null || val === undefined ? undefined : val;

const optionalEmail = z.preprocess(
  emptyToUndefined,
  z.string().email("Invalid email format").optional()
);

const optionalPhone = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional()
);

const optionalNotes = z.preprocess(
  emptyToUndefined,
  z.string().optional()
);

const patchEmptyToUndefined = (val: unknown) =>
  val === "" || val === undefined ? undefined : val;

const optionalEmailPatch = z.preprocess(
  patchEmptyToUndefined,
  z
    .union([z.string().email("Invalid email format"), z.null()])
    .optional()
);

const optionalPhonePatch = z.preprocess(
  patchEmptyToUndefined,
  z.union([z.string().min(1), z.null()]).optional()
);

const optionalNotesPatch = z.preprocess(
  patchEmptyToUndefined,
  z.union([z.string(), z.null()]).optional()
);

const optionalStringPatch = z.preprocess(
  patchEmptyToUndefined,
  z.union([z.string(), z.null()]).optional()
);

const requireEmailOrPhone = (
  data: { email?: string; phone?: string },
  ctx: z.RefinementCtx
) => {
  if (!data.email && !data.phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either email or phone is required for follow-up",
      path: ["email"],
    });
  }
};

export const createLeadSchema = z.object({
  body: z
    .object({
      name: z.string({ required_error: "Name is required" }).min(1),
      email: optionalEmail,
      phone: optionalPhone,
      notes: optionalNotes,
      company: z.string().optional(),
      location: z.string().optional(),
      status: z.string().optional(),
      followUpStage: z.string().min(1).optional(),
    })
    .superRefine(requireEmailOrPhone),
});

export const bulkDeleteLeadsSchema = z.object({
  body: z.object({
    leadIds: z
      .array(z.string().uuid("Invalid lead ID"))
      .min(1, "At least one lead ID is required")
      .max(200, "Maximum 200 leads per request"),
  }),
});

export const updateLeadSchema = z.object({
  body: z.object({
    name: z.string().min(1).optional(),
    email: optionalEmailPatch,
    phone: optionalPhonePatch,
    notes: optionalNotesPatch,
    company: optionalStringPatch,
    location: optionalStringPatch,
    status: z.string().optional(),
    followUpStage: z.string().nullable().optional(),
  }),
});

/** Marking a lead do-not-contact. The reason is optional. */
export const markDoNotContactSchema = z.object({
  body: z
    .object({
      reason: z.string().trim().max(300, "Reason must be 300 characters or less").optional(),
    })
    .optional()
    .transform((body) => body ?? {}),
});

/** Clearing do-not-contact. A reason is required and is stored with the record. */
export const clearDoNotContactSchema = z.object({
  body: z.object({
    reason: z
      .string({ required_error: "A reason is required" })
      .trim()
      .min(1, "A reason is required")
      .max(300, "Reason must be 300 characters or less"),
  }),
});

export type MarkDoNotContactInput = z.infer<typeof markDoNotContactSchema>["body"];
export type ClearDoNotContactInput = z.infer<typeof clearDoNotContactSchema>["body"];
export type CreateLeadInput = z.infer<typeof createLeadSchema>["body"];
export type BulkDeleteLeadsInput = z.infer<typeof bulkDeleteLeadsSchema>["body"];
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>["body"];

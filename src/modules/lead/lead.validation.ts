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

export const createLeadSchema = z.object({
  body: z.object({
    name: z.string({ required_error: "Name is required" }).min(1),
    email: optionalEmail,
    phone: optionalPhone,
    notes: optionalNotes,
    company: z.string().optional(),
    location: z.string().optional(),
    status: z.string().optional(),
    followUpStage: z.string({ required_error: "Follow-up stage is required" }).min(1),
  }),
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
    company: z.string().min(1).optional(),
    location: z.string().min(1).optional(),
    status: z.string().optional(),
    followUpStage: z.string().nullable().optional(),
  }),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>["body"];
export type BulkDeleteLeadsInput = z.infer<typeof bulkDeleteLeadsSchema>["body"];
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>["body"];

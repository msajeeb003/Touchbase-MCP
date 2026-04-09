/**
 * Persisted values for `SequenceStep.status` (see prisma `sequence_steps.status`).
 */
export const SEQUENCE_STEP_STATUS = {
  PENDING: "pending",
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
} as const;

export type SequenceStepStatus =
  (typeof SEQUENCE_STEP_STATUS)[keyof typeof SEQUENCE_STEP_STATUS];

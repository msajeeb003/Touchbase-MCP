import { Prisma } from "@prisma/client";
import prisma from "../prisma";

export type ActivityEventType =
  | "sequence_created"
  | "sequence_generated"
  | "sequence_regenerated"
  | "sequence_status_changed"
  | "sequence_edited"
  | "step_scheduled"
  | "step_sent"
  | "step_sending"
  | "step_delivered"
  | "step_failed"
  | "step_edited"
  | "step_generated";

interface LogActivityParams {
  sequenceId: string;
  stepId?: string;
  eventType: ActivityEventType;
  actor: "user" | "system";
  meta?: Record<string, unknown>;
}

/**
 * Writes one activity event. Callers that do not wait for it may ignore the
 * returned promise; the send job waits, because on a serverless host (Vercel)
 * work left running after the response can be cut off. A failed write is
 * logged, never thrown and never silent.
 */
export const logActivity = (params: LogActivityParams): Promise<void> =>
  prisma.sequenceActivity
    .create({
      data: {
        sequenceId: params.sequenceId,
        stepId:     params.stepId ?? null,
        eventType:  params.eventType,
        actor:      params.actor,
        meta:       (params.meta ?? {}) as Prisma.InputJsonValue,
      },
    })
    .then(() => undefined)
    .catch((error) => {
      console.error(
        `[Activity] Could not record "${params.eventType}" for sequence ${params.sequenceId}:`,
        error
      );
    });

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
  | "step_edited";

interface LogActivityParams {
  sequenceId: string;
  stepId?: string;
  eventType: ActivityEventType;
  actor: "user" | "system";
  meta?: Record<string, unknown>;
}

export const logActivity = (params: LogActivityParams): void => {
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
    .catch(() => {});
};

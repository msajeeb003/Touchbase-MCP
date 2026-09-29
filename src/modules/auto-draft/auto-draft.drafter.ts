import prisma from "../../shared/prisma";
import type { AIProvider } from "../../shared/constants";
import { SettingsService } from "../settings/settings.service";
import { SequenceService } from "../sequence/sequence.service";
import { AUTO_DRAFT_DEFAULTS } from "./auto-draft.constants";
import { selectTemplateAndGoal } from "./template-selector";

const LOG_PREFIX = "[AutoDraft]";

export type DraftOutcome =
  | {
      status: "created";
      sequenceId: string;
      sequenceName: string;
      templateName: string;
      goal: string;
      selectedBy: "ai" | "stage";
      stepsGenerated: number;
      totalSteps: number;
    }
  | { status: "skipped"; reason: string };

/**
 * Creates one draft follow-up sequence for the lead from the given meeting transcript.
 * Never throws; every failure comes back as a skipped outcome with a reason.
 */
export const createDraftForLead = async (params: {
  userId: string;
  leadId: string;
  transcript: string;
}): Promise<DraftOutcome> => {
  const { userId, leadId, transcript } = params;

  try {
    if (!transcript.trim()) return { status: "skipped", reason: "no_transcript" };

    const [templates, aiSettings, aiApiKey, lead] = await Promise.all([
      prisma.promptTemplate.findMany({
        where: { userId },
        select: { id: true, name: true, followUpStage: true, promptText: true },
        orderBy: { name: "asc" },
      }),
      prisma.userSettings.findUnique({
        where: { userId },
        select: { aiProvider: true, aiModel: true },
      }),
      SettingsService.getDecryptedField(userId, "aiApiKey"),
      prisma.lead.findFirst({
        where: { id: leadId, userId },
        select: { followUpStage: true },
      }),
    ]);

    if (!lead) return { status: "skipped", reason: "lead_not_found" };
    if (templates.length === 0) return { status: "skipped", reason: "no_templates" };
    if (!aiSettings?.aiProvider || !aiApiKey) return { status: "skipped", reason: "ai_not_configured" };

    const selection = await selectTemplateAndGoal({
      templates,
      transcript,
      leadStage: lead.followUpStage,
      ai: {
        provider: aiSettings.aiProvider as AIProvider,
        apiKey: aiApiKey,
        model: aiSettings.aiModel ?? undefined,
      },
    });

    if (!selection) return { status: "skipped", reason: "no_matching_template" };

    const { sequence, generationResults } = await SequenceService.generateAndSave(
      userId,
      {
        leadId,
        promptTemplateId: selection.template.id,
        goal: selection.goal,
        preferences: {
          tone: AUTO_DRAFT_DEFAULTS.tone,
          intensity: AUTO_DRAFT_DEFAULTS.intensity,
          cadence: AUTO_DRAFT_DEFAULTS.cadence,
          channels: [...AUTO_DRAFT_DEFAULTS.channels],
        },
      },
      { allowWhileActive: true, actor: "system" }
    );

    if (!sequence) return { status: "skipped", reason: "sequence_not_returned" };

    return {
      status: "created",
      sequenceId: sequence.id,
      sequenceName: sequence.name,
      templateName: selection.template.name,
      goal: selection.goal,
      selectedBy: selection.source,
      stepsGenerated: generationResults.filter((r) => r.status === "generated").length,
      totalSteps: generationResults.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`${LOG_PREFIX} Draft creation failed for lead ${leadId}:`, err);
    return { status: "skipped", reason: `failed: ${message}` };
  }
};

export const logDraftOutcome = (leadEmail: string, outcome: DraftOutcome): void => {
  if (outcome.status === "created") {
    console.log(
      `${LOG_PREFIX} Draft created — lead ${leadEmail}, sequence ${outcome.sequenceId} "${outcome.sequenceName}", ` +
        `template "${outcome.templateName}", goal "${outcome.goal}" (by ${outcome.selectedBy}), ` +
        `steps ${outcome.stepsGenerated}/${outcome.totalSteps}`
    );
  } else {
    console.log(`${LOG_PREFIX} Draft skipped — lead ${leadEmail}: ${outcome.reason}`);
  }
};

import prisma from "../prisma";
import { SettingsService } from "../../modules/settings/settings.service";

interface RetellConfig {
  apiKey: string;
  agentId: string;
}

const getRetellConfig = async (userId: string): Promise<RetellConfig> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { retellAgentId: true },
  });

  if (!settings?.retellAgentId) {
    throw new Error("Retell Agent ID not configured. Set it in Settings.");
  }

  const apiKey = await SettingsService.getDecryptedField(userId, "retellApiKey");

  if (!apiKey) {
    throw new Error("Retell API Key not configured. Set it in Settings.");
  }

  return { apiKey, agentId: settings.retellAgentId };
};

interface TriggerCallParams {
  userId: string;
  stepId: string;
  sequenceId: string;
  phone: string;
  agentPrompt: string;
  leadName: string;
  leadCompany: string;
}

interface TriggerCallResult {
  callId: string;
}

export const triggerCall = async (
  params: TriggerCallParams
): Promise<TriggerCallResult> => {
  const config = await getRetellConfig(params.userId);

  const fromNumber = await getCallerNumber(params.userId);

  const response = await fetch(
    "https://api.retellai.com/v2/create-phone-call",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: params.phone,
        agent_id: config.agentId,
        retell_llm_dynamic_variables: {
          lead_name: params.leadName,
          company: params.leadCompany,
          context: params.agentPrompt,
        },
        metadata: {
          stepId: params.stepId,
          sequenceId: params.sequenceId,
          userId: params.userId,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Retell API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { call_id: string };
  return { callId: data.call_id };
};

const getCallerNumber = async (userId: string): Promise<string> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { twilioPhoneNumber: true },
  });

  if (!settings?.twilioPhoneNumber) {
    throw new Error(
      "Phone number not configured. Set Twilio Phone Number in Settings."
    );
  }

  return settings.twilioPhoneNumber;
};

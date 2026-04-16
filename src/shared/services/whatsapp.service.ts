import prisma from "../prisma";
import { SettingsService } from "../../modules/settings/settings.service";

interface WhatsAppConfig {
  accountSid: string;
  authToken: string;
  whatsappNumber: string;
}

const getWhatsAppConfig = async (userId: string): Promise<WhatsAppConfig> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { twilioAccountSid: true, twilioWhatsappNumber: true },
  });

  if (!settings?.twilioAccountSid) {
    throw new Error("Twilio Account SID not configured");
  }

  if (!settings.twilioWhatsappNumber) {
    throw new Error(
      "Twilio WhatsApp number not configured. Set it in Settings."
    );
  }

  const authToken = await SettingsService.getDecryptedField(
    userId,
    "twilioAuthToken"
  );

  if (!authToken) {
    throw new Error("Twilio Auth Token not configured");
  }

  return {
    accountSid: settings.twilioAccountSid,
    authToken,
    whatsappNumber: settings.twilioWhatsappNumber,
  };
};

export const sendWhatsApp = async (
  userId: string,
  phone: string,
  text: string
): Promise<void> => {
  const config = await getWhatsAppConfig(userId);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const credentials = btoa(`${config.accountSid}:${config.authToken}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      To: `whatsapp:${phone}`,
      From: `whatsapp:${config.whatsappNumber}`,
      Body: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twilio WhatsApp API error (${response.status}): ${error}`);
  }
};

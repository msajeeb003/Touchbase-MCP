import { SettingsService } from "../../modules/settings/settings.service";

interface SmsConfig {
  username: string;
  apiKey: string;
}

const getTextMagicConfig = async (userId: string): Promise<SmsConfig> => {
  const settings = await import("../../shared/prisma").then((m) =>
    m.default.userSettings.findUnique({
      where: { userId },
      select: { textmagicUsername: true },
    })
  );

  if (!settings?.textmagicUsername) {
    throw new Error("TextMagic username not configured");
  }

  const apiKey = await SettingsService.getDecryptedField(
    userId,
    "textmagicApiKey"
  );

  if (!apiKey) {
    throw new Error("TextMagic API key not configured");
  }

  return {
    username: settings.textmagicUsername,
    apiKey,
  };
};

export const sendSms = async (
  userId: string,
  phone: string,
  text: string
): Promise<void> => {
  const config = await getTextMagicConfig(userId);
  const response = await fetch(
    "https://rest.textmagic.com/api/v2/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TM-Username": config.username,
        "X-TM-Key": config.apiKey,
      },
      body: JSON.stringify({
        text,
        phones: phone,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`TextMagic API error (${response.status}): ${error}`);
  }
};

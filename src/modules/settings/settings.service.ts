import prisma from "../../shared/prisma";
import { encrypt, decrypt, maskSecret } from "../../shared/utils/encryption";
import { UpdateSettingsInput } from "./settings.validation";
import AppError from "../../shared/errors/AppError";
import {
  DEFAULT_SEND_WINDOW_END,
  DEFAULT_SEND_WINDOW_START,
  parseTimeOfDay,
} from "../../harness/send-window";

const SENSITIVE_FIELDS = [
  "aiApiKey",
  "fathomApiKey",
  "smtpPassword",
  "textmagicApiKey",
  "twilioAuthToken",
  "retellApiKey",
  "fathomWebhookSecret",
] as const;

type SensitiveField = (typeof SENSITIVE_FIELDS)[number];

const isSensitiveField = (key: string): key is SensitiveField => {
  return SENSITIVE_FIELDS.includes(key as SensitiveField);
};

const encryptFields = (
  data: UpdateSettingsInput
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    if (isSensitiveField(key) && typeof value === "string") {
      result[key] = encrypt(value);
    } else {
      result[key] = value;
    }
  }

  return result;
};

const decryptAndMask = (
  settings: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(settings)) {
    if (isSensitiveField(key) && typeof value === "string") {
      try {
        const decrypted = decrypt(value);
        result[key] = maskSecret(decrypted);
      } catch {
        result[key] = null;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
};

const SETTINGS_SELECT = {
  id: true,
  userId: true,
  aiProvider: true,
  aiApiKey: true,
  aiModel: true,
  fathomApiKey: true,
  smtpHost: true,
  smtpPort: true,
  smtpUsername: true,
  smtpPassword: true,
  smtpFromName: true,
  smsProvider: true,
  textmagicUsername: true,
  textmagicApiKey: true,
  twilioAccountSid: true,
  twilioAuthToken: true,
  twilioPhoneNumber: true,
  twilioWhatsappNumber: true,
  retellApiKey: true,
  retellAgentId: true,
  retellCallerNumber: true,
  autoDraftEnabled: true,
  sendWindowStart: true,
  sendWindowEnd: true,
  sendOnWeekends: true,
  sendTimezone: true,
  claudeCanActivate: true,
  claudeCanResume: true,
  claudeCanEditSettings: true,
  claudeCanDeleteLeads: true,
  claudeCanClearDoNotContact: true,
  claudeDailyActivationCap: true,
  // fathomWebhookId / fathomWebhookSecret are intentionally never returned
  createdAt: true,
  updatedAt: true,
};

const getSettings = async (userId: string) => {
  let settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: SETTINGS_SELECT,
  });

  if (!settings) {
    settings = await prisma.userSettings.create({
      data: { userId },
      select: SETTINGS_SELECT,
    });
  }

  return decryptAndMask(settings as unknown as Record<string, unknown>);
};

const updateSettings = async (
  userId: string,
  payload: UpdateSettingsInput
) => {
  // Send window: the start must be before the end, also when only one of the
  // two is being changed.
  if (
    payload.sendWindowStart !== undefined ||
    payload.sendWindowEnd !== undefined
  ) {
    const current = await prisma.userSettings.findUnique({
      where: { userId },
      select: { sendWindowStart: true, sendWindowEnd: true },
    });
    const start = parseTimeOfDay(
      payload.sendWindowStart ?? current?.sendWindowStart ?? DEFAULT_SEND_WINDOW_START
    );
    const end = parseTimeOfDay(
      payload.sendWindowEnd ?? current?.sendWindowEnd ?? DEFAULT_SEND_WINDOW_END
    );

    if (start === null || end === null || start >= end) {
      throw new AppError(
        400,
        "The send window start time must be before the end time."
      );
    }
  }

  const encryptedData = encryptFields(payload);

  const settings = await prisma.userSettings.upsert({
    where: { userId },
    update: encryptedData,
    create: { userId, ...encryptedData },
    select: SETTINGS_SELECT,
  });

  return decryptAndMask(settings as unknown as Record<string, unknown>);
};

const getDecryptedField = async (
  userId: string,
  field: SensitiveField
): Promise<string | null> => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { [field]: true },
  });

  if (!settings) return null;

  const value = (settings as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;

  try {
    return decrypt(value);
  } catch {
    return null;
  }
};

export const SettingsService = {
  getSettings,
  updateSettings,
  getDecryptedField,
};

import AppError from "../../shared/errors/AppError";
import { SettingsService } from "../settings/settings.service";
import { FATHOM_BASE_URL, FATHOM_ERRORS } from "./fathom.constant";

const getFathomApiKey = async (userId: string): Promise<string> => {
  const apiKey = await SettingsService.getDecryptedField(
    userId,
    "fathomApiKey"
  );

  if (!apiKey) {
    throw new AppError(400, FATHOM_ERRORS.NO_API_KEY);
  }

  return apiKey;
};

const fathomFetch = async (
  apiKey: string,
  path: string,
  queryParams?: Record<string, string>
) => {
  const url = new URL(`${FATHOM_BASE_URL}${path}`);

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value) url.searchParams.append(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { "X-Api-Key": apiKey },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new AppError(401, FATHOM_ERRORS.INVALID_API_KEY);
    }
    if (response.status === 429) {
      throw new AppError(429, FATHOM_ERRORS.RATE_LIMITED);
    }
    throw new AppError(response.status, FATHOM_ERRORS.FATHOM_ERROR);
  }

  return response.json();
};

type MeetingsQuery = {
  cursor?: string;
  created_after?: string;
  created_before?: string;
  include_summary?: string;
  include_transcript?: string;
  include_action_items?: string;
};

const getMeetings = async (userId: string, query: MeetingsQuery) => {
  const apiKey = await getFathomApiKey(userId);

  return fathomFetch(apiKey, "/meetings", query as Record<string, string>);
};

const getTranscript = async (userId: string, recordingId: string) => {
  const apiKey = await getFathomApiKey(userId);

  return fathomFetch(apiKey, `/recordings/${recordingId}/transcript`);
};

const getSummary = async (userId: string, recordingId: string) => {
  const apiKey = await getFathomApiKey(userId);

  return fathomFetch(apiKey, `/recordings/${recordingId}/summary`);
};

export const FathomService = {
  getMeetings,
  getTranscript,
  getSummary,
};

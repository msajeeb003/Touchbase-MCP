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

type FathomRequestInit = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
};

const fathomFetch = async (
  apiKey: string,
  path: string,
  queryParams?: Record<string, string>,
  init?: FathomRequestInit
) => {
  const url = new URL(`${FATHOM_BASE_URL}${path}`);

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value) url.searchParams.append(key, value);
    }
  }

  const hasBody = init?.body !== undefined;

  const response = await fetch(url.toString(), {
    method: init?.method ?? "GET",
    headers: {
      "X-Api-Key": apiKey,
      ...(hasBody && { "Content-Type": "application/json" }),
    },
    body: hasBody ? JSON.stringify(init!.body) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    console.error(
      `[Fathom] ${init?.method ?? "GET"} ${path} → ${response.status}: ${errorBody}`
    );

    if (response.status === 401) {
      throw new AppError(401, FATHOM_ERRORS.INVALID_API_KEY);
    }
    if (response.status === 429) {
      throw new AppError(429, FATHOM_ERRORS.RATE_LIMITED);
    }
    throw new AppError(response.status, FATHOM_ERRORS.FATHOM_ERROR);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

type MeetingsQuery = {
  cursor?: string;
  include_summary?: string;
  include_transcript?: string;
  include_action_items?: string;
};

type FathomMeetingsPage = {
  items: unknown[];
  limit: number | null;
  next_cursor: string | null;
};

type MeetingsListResult = {
  items: unknown[];
  limit: number | null;
  next_cursor: string | null;
  hasMore: boolean;
};

/** Fathom pages fetched per request (~10 meetings/page → ~30 per load). */
const MAX_PAGES = 10;

const getMeetings = async (
  userId: string,
  query: MeetingsQuery
): Promise<MeetingsListResult> => {
  const apiKey = await getFathomApiKey(userId);
  const { cursor: startCursor, ...filters } = query;

  const items: unknown[] = [];
  let cursor: string | undefined = startCursor;
  let limit: number | null = null;
  let next_cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      ...(filters as Record<string, string>),
    };
    if (cursor) params.cursor = cursor;

    const data = (await fathomFetch(
      apiKey,
      "/meetings",
      params
    )) as FathomMeetingsPage;

    items.push(...(data.items || []));
    limit = items.length;
    // limit = data.limit ?? limit;
    next_cursor = data.next_cursor;

    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return {
    items,
    limit,
    next_cursor,
    hasMore: !!next_cursor,
  };
};

const getTranscript = async (userId: string, recordingId: string) => {
  const apiKey = await getFathomApiKey(userId);

  return fathomFetch(apiKey, `/recordings/${recordingId}/transcript`);
};

const getSummary = async (userId: string, recordingId: string) => {
  const apiKey = await getFathomApiKey(userId);

  return fathomFetch(apiKey, `/recordings/${recordingId}/summary`);
};

export type FathomWebhook = {
  id: string;
  url: string;
  secret: string;
  created_at: string;
  include_transcript: boolean;
  include_summary: boolean;
  include_action_items: boolean;
  include_crm_matches: boolean;
  triggered_for: string[];
};

/** Registers a webhook on Fathom that fires after each of the user's own meetings is processed. */
const createWebhook = async (
  userId: string,
  destinationUrl: string
): Promise<FathomWebhook> => {
  const apiKey = await getFathomApiKey(userId);

  const webhook = (await fathomFetch(apiKey, "/webhooks", undefined, {
    method: "POST",
    body: {
      destination_url: destinationUrl,
      triggered_for: ["my_recordings"],
      include_transcript: true,
    },
  })) as FathomWebhook | null;

  if (!webhook?.id || !webhook.secret) {
    throw new AppError(502, "Fathom did not return a webhook id and secret");
  }

  return webhook;
};

const deleteWebhook = async (userId: string, webhookId: string): Promise<void> => {
  const apiKey = await getFathomApiKey(userId);
  await fathomFetch(apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, undefined, {
    method: "DELETE",
  });
};

export const FathomService = {
  getMeetings,
  getTranscript,
  getSummary,
  createWebhook,
  deleteWebhook,
};

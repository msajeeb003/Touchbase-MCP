import AppError from "../shared/errors/AppError";

/**
 * AI harness: the errors a tool can answer with.
 *
 * Every error tells Claude three things: a fixed code, what went wrong in one
 * plain sentence, and what to do next. The text is written for Claude to read
 * and act on, so it must never contain a secret or another user's data.
 */
export type HarnessErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_CLOSED"
  | "NOT_FOUND"
  | "VALIDATION"
  | "LIMIT_EXCEEDED"
  | "CHANNEL_NOT_SUPPORTED"
  | "DO_NOT_CONTACT"
  | "NOT_A_DRAFT"
  | "HUMAN_ONLY"
  | "MISSING_ADDRESS"
  | "TRANSCRIPT_NOT_READ"
  | "PLACEHOLDER_LEFT"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly nextStep: string;
  /** Small extra facts that help Claude act, for example unread_transcript_id. */
  readonly extra: Record<string, unknown>;

  constructor(
    code: HarnessErrorCode,
    message: string,
    nextStep: string,
    extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.nextStep = nextStep;
    this.extra = extra;
  }
}

export const isHarnessError = (error: unknown): error is HarnessError =>
  error instanceof HarnessError;

/** What every harness function returns to the tool wrapper. */
export type HarnessOutcome = {
  /** The structured answer for Claude. */
  result: Record<string, unknown>;
  /** One line for a person. Stored in the run event and shown in the app. */
  summary: string;
  /** The records this call touched. */
  touched?: { type: string; id: string; label?: string }[];
  /** Small facts the server needs later (for example which transcript was read). */
  detail?: Record<string, unknown>;
};

/**
 * For the app's REST routes: runs a harness call and turns a harness error into
 * the API's usual error (404 for a missing record or run, otherwise 400).
 */
export const asRestCall = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (isHarnessError(error)) {
      const missing = error.code === "NOT_FOUND" || error.code === "RUN_NOT_FOUND";
      throw new AppError(missing ? 404 : 400, error.code === "RUN_NOT_FOUND" ? "Run not found" : error.message);
    }
    throw error;
  }
};

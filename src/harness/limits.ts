/**
 * AI harness, rule 5: limits on everything.
 *
 * Every limit is a named value in this one file (MCP_DESIGN.md, section 9).
 * A call over a limit is answered with LIMIT_EXCEEDED, the limit, and what to
 * do next. The object is not frozen so a test can lower a limit for one case.
 */
export const LIMITS = {
  // sequences and steps
  STEPS_PER_SEQUENCE: 10,
  LEADS_PER_BULK_CALL: 25,
  ROWS_PER_IMPORT: 100,
  SEQUENCES_PER_RUN: 200,
  DELAY_MAX_DAYS: 60,
  SEQUENCE_MAX_DAYS: 90,

  // pages
  PAGE_SIZE_DEFAULT: 20,
  PAGE_SIZE_MAX: 50,

  // text
  INSTRUCTION_MAX: 2_000,
  RUN_SUMMARY_MAX: 500,
  EMAIL_SUBJECT_MAX: 150,
  EMAIL_BODY_MAX: 5_000,
  SMS_BODY_MAX: 480,
  SMS_SINGLE_PART: 160,
  TEMPLATE_PROMPT_MAX: 8_000,
  SEQUENCE_NAME_MAX: 150,
  TEMPLATE_NAME_MAX: 100,
  GOAL_NAME_MAX: 150,
  NOTES_MAX: 5_000,
  REASON_MAX: 300,
  BASED_ON_NOTE_MAX: 200,
  BASED_ON_TRANSCRIPTS_MAX: 3,
  REPLY_BODY_MAX: 4_000,

  // transcripts
  PASTED_TRANSCRIPT_MAX: 100_000,
  PASTED_TRANSCRIPTS_PER_LEAD_PER_RUN: 10,
  TRANSCRIPT_CHARS_PER_READ: 20_000,
  TRANSCRIPT_MUST_READ_CHARS: 60_000,

  // reporting
  RECENT_ACTIVITY_DEFAULT_DAYS: 7,
  RECENT_ACTIVITY_MAX_DAYS: 90,

  // results and rates
  TOOL_RESULT_MAX_CHARS: 40_000,
  TOOL_CALLS_PER_MINUTE: 120,
  TOOL_CALLS_PER_RUN: 500,
  RUNS_PER_USER_PER_HOUR: 20,
  RUN_EVENTS_PER_READ: 50,
  RUN_SEQUENCES_PER_READ: 10,
  RUN_SEQUENCES_PER_READ_MAX: 25,

  // runs and tokens
  RUN_ABANDONED_AFTER_HOURS: 24,
  /** start_run called again with the same instruction inside this time returns the same run. */
  START_RUN_REPEAT_MINUTES: 10,
  TOKEN_DEFAULT_DAYS: 90,
  TOKEN_MAX_DAYS: 365,
  TOKENS_PER_USER: 10,
  TOKEN_NAME_MAX: 100,
};

/** The limits Claude is told about when a run starts. */
export const limitsForClaude = () => ({
  steps_per_sequence: LIMITS.STEPS_PER_SEQUENCE,
  leads_per_call: LIMITS.LEADS_PER_BULK_CALL,
  rows_per_import: LIMITS.ROWS_PER_IMPORT,
  sequences_per_run: LIMITS.SEQUENCES_PER_RUN,
  page_size_max: LIMITS.PAGE_SIZE_MAX,
  email_subject_chars: LIMITS.EMAIL_SUBJECT_MAX,
  email_body_chars: LIMITS.EMAIL_BODY_MAX,
  sms_body_chars: LIMITS.SMS_BODY_MAX,
  delay_days_max: LIMITS.DELAY_MAX_DAYS,
  sequence_days_max: LIMITS.SEQUENCE_MAX_DAYS,
  tool_calls_per_minute: LIMITS.TOOL_CALLS_PER_MINUTE,
  tool_calls_per_run: LIMITS.TOOL_CALLS_PER_RUN,
});

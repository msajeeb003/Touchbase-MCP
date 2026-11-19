/**
 * AI harness, rule 3: every tool acts as exactly one authenticated user.
 *
 * The actor is built from the access token, never from anything Claude sends.
 * Every harness function takes it and puts `userId` into its queries, so
 * knowing an ID is never enough to reach another user's record.
 */
export type Actor = {
  /** The Touchbase user this connection acts for. */
  userId: string;
  /** Always "mcp" here. A logged-in person in the app is a different path. */
  actor: "mcp";
  /** The access token that was used. */
  tokenId: string;
  /** What connected, as far as it says (for example "claude-code"). Shown in the run. */
  clientName: string | null;
};

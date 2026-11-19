/** An OAuth error, with the standard code (RFC 6749) and the HTTP status to answer with. */
export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;

  constructor(error: string, description: string, status = 400) {
    super(description);
    this.name = "OAuthError";
    this.error = error;
    this.status = status;
  }
}

export const isOAuthError = (value: unknown): value is OAuthError => value instanceof OAuthError;

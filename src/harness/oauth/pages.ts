import { createHash, createHmac, timingSafeEqual } from "crypto";
import config from "../../config";
import { CANNOT_TEXT, PERMISSIONS_TEXT, SIGNED_REQUEST_SECONDS } from "./config";

/**
 * The sign-in page a customer sees when an app (Claude) asks to connect.
 *
 * It is a plain server-made page: no script, no outside files. The details of
 * the request travel in a signed, time-limited hidden field, so they cannot be
 * changed between showing the page and pressing "Allow".
 */

export type AuthorizeRequest = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string;
};

const signingKey = () =>
  createHash("sha256").update(`touchbase-oauth-request:${config.jwt.secret}`).digest();

export const signRequest = (request: AuthorizeRequest): string => {
  const body = Buffer.from(
    JSON.stringify({ ...request, exp: Date.now() + SIGNED_REQUEST_SECONDS * 1000 })
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(body).digest("base64url");
  return `${body}.${signature}`;
};

/** The request behind a signed field, or null if it was changed or has expired. */
export const readSignedRequest = (value: unknown): AuthorizeRequest | null => {
  if (typeof value !== "string" || !value.includes(".")) return null;
  const [body, signature] = value.split(".");
  const expected = createHmac("sha256", signingKey()).update(body).digest("base64url");
  const a = Buffer.from(signature ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    const { exp: _exp, ...request } = parsed;
    return request as AuthorizeRequest;
  } catch {
    return null;
  }
};

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const STYLE = `
  :root { color-scheme: light dark; --bg:#0f172a; --card:#111c33; --text:#e2e8f0; --muted:#94a3b8; --accent:#6366f1; --line:#24324f; --bad:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
         background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 6px; } p { margin:0 0 14px; color:var(--muted); }
  .app { color:var(--text); font-weight:600; } ul { margin:0 0 14px; padding-left:20px; } li { margin:4px 0; }
  .note { font-size:14px; border-left:3px solid var(--accent); padding-left:10px; }
  label { display:block; font-size:14px; margin:12px 0 4px; }
  input[type=email], input[type=password] { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line);
         background:#0b1426; color:var(--text); font-size:16px; }
  .error { color:var(--bad); font-size:14px; margin-top:12px; }
  .buttons { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; padding:11px; border-radius:8px; font-size:16px; cursor:pointer; border:1px solid var(--line); background:transparent; color:var(--text); }
  button.allow { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .small { font-size:13px; margin-top:16px; }
`;

const page = (title: string, content: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Touchbase</title><style>${STYLE}</style></head>
<body><main>${content}</main></body></html>`;

export const consentPage = (
  request: AuthorizeRequest,
  options: { error?: string; email?: string } = {}
): string => {
  const destination = new URL(request.redirectUri).host;
  return page(
    "Connect an app",
    `<h1>Connect to Touchbase</h1>
     <p><span class="app">${escape(request.clientName)}</span> wants to use your Touchbase account. It will be able to:</p>
     <ul>${PERMISSIONS_TEXT.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
     <p class="note">${escape(CANNOT_TEXT)}</p>
     <form method="post" action="/oauth/authorize" autocomplete="on">
       <input type="hidden" name="request" value="${escape(signRequest(request))}">
       <label for="email">Touchbase email</label>
       <input id="email" name="email" type="email" required autocomplete="username" value="${escape(options.email ?? "")}">
       <label for="password">Password</label>
       <input id="password" name="password" type="password" required autocomplete="current-password">
       ${options.error ? `<div class="error" role="alert">${escape(options.error)}</div>` : ""}
       <div class="buttons">
         <button type="submit" name="action" value="deny" formnovalidate>Cancel</button>
         <button type="submit" name="action" value="allow" class="allow">Allow</button>
       </div>
     </form>
     <p class="small">After you allow it, you will be sent back to ${escape(destination)}. You can disconnect the app at any time in Touchbase.</p>`
  );
};

export const errorPage = (message: string): string =>
  page(
    "Cannot connect",
    `<h1>This app cannot connect</h1>
     <p>${escape(message)}</p>
     <p class="small">Close this window and try connecting again from the app. If it keeps happening, contact Touchbase support.</p>`
  );

/** Headers for every sign-in page: never cached, never shown inside another site. */
export const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

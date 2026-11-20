# Deploying a TEST copy of the backend on Vercel

This is for a test copy (mock mode, its own test database), so claude.ai can be
tried against a public HTTPS address without touching the live app on Hetzner.
The live app and its database stay as they are.

## What is in the repo for Vercel

- `vercel.json`: install with npm, then run `scripts/vercel-build.cjs`.
- `scripts/vercel-build.cjs`: sets up the database tables (only when `MIGRATE_ON_BUILD=true`),
  generates the database client, and compiles TypeScript into `dist/` (no source maps).
  Vercel then finds the Express app in `dist/app.js` and runs it as one function.
- `public/`: the only folder Vercel serves as plain files (just a robots.txt).

Vercel runs `dist/app.js`, not `server.js`, so there is no `app.listen` and no
background job there. Due steps are sent only when something calls the send-job
endpoint `/api/v1/internal/send-tick` with `Authorization: Bearer <CRON_SECRET>`.
Each call runs one pass: due steps inside the send window go out (in mock mode they
are recorded as mock sends), steps outside it move to when the window next opens.
Without `CRON_SECRET` the endpoint is off and steps stay "scheduled" forever.
The reply check still does not run on Vercel.

## Steps

1. **Database:** in the Vercel backend project, open **Storage → Create Database → Neon**
   (free), and connect it to this project (Production). Vercel then sets
   `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED` (direct, used to set up tables).
2. **Settings:** in **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `JWT_SECRET` | a new long random text, not the live one |
| `ENCRYPTION_KEY` | a new 64-character hex text, not the live one |
| `ENABLE_MCP` | `true` |
| `MCP_PUBLIC` | `true` |
| `MCP_PUBLIC_URL` | `https://<your-backend-project>.vercel.app` (no slash at the end) |
| `MIGRATE_ON_BUILD` | `true` (sets up the tables during each build) |
| `OUTBOUND_MODE` | leave **unset** (mock: nothing is sent) |
| `CRON_SECRET` | a new long random text; turns on the send job (see below) |

3. **Deployment Protection:** Settings → Deployment Protection → off for this project,
   otherwise Claude cannot reach `/mcp`.
4. **Redeploy** (Deployments → the latest → Redeploy). The build log should show
   `[vercel-build] Setting up database tables` and the migrations being applied.
5. **Frontend project:** set `VITE_BASE_URL` to `https://<your-backend-project>.vercel.app/api/v1`
   and redeploy it. Without this, the test frontend talks to the live backend.
6. **Test account:** register in the test frontend.
7. **Claude:** claude.ai → Settings → Connectors → Add custom connector →
   `https://<your-backend-project>.vercel.app/mcp` → sign in with the test account → Allow.

## The send job on Vercel

`vercel.json` has a Vercel Cron that calls the send-job endpoint once a day at 04:00 UTC
(10:00 in Dhaka). Vercel sends `CRON_SECRET` with it by itself. Once a day is the most the
free plan allows, so it is only a safety net: for steps to go out within a minute or two of
their time, the endpoint needs calling every minute, by Vercel Pro (change the schedule to
`* * * * *`) or by an outside scheduler that sends the same header.

Test it by hand (prints what the pass did):

    curl -X POST https://<your-backend-project>.vercel.app/api/v1/internal/send-tick -H "Authorization: Bearer <CRON_SECRET>"

## Limits on Vercel (free plan)

- The send job runs only when the endpoint is called (see above). No reply check.
- The wrong-password limit and the rate limit are kept in memory, so each Vercel instance counts on its own.
- Not verified yet: the app on Neon's pooled connection. If you see errors about
  "prepared statement", tell the developer; the fix is a small connection setting.

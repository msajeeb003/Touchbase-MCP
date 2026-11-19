# Deploying a TEST copy of the backend on Vercel

This is for a test copy (mock mode, test database), so claude.ai can be tried
against a public HTTPS address without touching the live app on Hetzner.
The live app stays on Hetzner.

## What is in the repo for Vercel

- `vercel.json`: install, build (`prisma generate` + TypeScript), and one function that receives every request.
- `api/index.js`: the function. It loads the compiled Express app from `dist/`.
- `public/`: the only folder Vercel serves as plain files (just a robots.txt), so the compiled code is never downloadable.

There is no `app.listen` and no background job on Vercel: the send job and the
reply check do not run there. In mock mode nothing is sent anyway.

## Steps

1. **Create a test database:** a new Supabase project (empty). Copy its connection string
   (the pooled one, port 6543, with `?pgbouncer=true&connection_limit=1` at the end).
2. **Apply the migrations to it** from this computer, once:
   `DATABASE_URL="<test connection string>" node node_modules/prisma/build/index.js migrate deploy`
   (use the direct connection string, port 5432, for this step).
3. **Create a new Vercel project** from this folder (`vercel` CLI, or import the GitHub repo
   `msajeeb003/Touchbase-MCP`, branch `ai-harness-mcp`).
4. **Set the environment variables** in Vercel → Project → Settings → Environment Variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | the test database's pooled connection string |
| `JWT_SECRET` | a new long random text (not the live one) |
| `ENCRYPTION_KEY` | a new 64-character hex text (not the live one) |
| `ENABLE_MCP` | `true` |
| `MCP_PUBLIC` | `true` |
| `MCP_PUBLIC_URL` | `https://<your-project>.vercel.app` (no slash at the end) |
| `OUTBOUND_MODE` | leave **unset** (mock: nothing is sent) |

5. **Turn off Vercel's login wall** for this project (Settings → Deployment Protection),
   otherwise Claude cannot reach `/mcp`.
6. **Deploy**, then create a test account in the app (or with `POST /api/v1/auth/register`).
7. **Connect Claude:** claude.ai → Settings → Connectors → Add custom connector →
   `https://<your-project>.vercel.app/mcp` → sign in with the test account → Allow.

## Limits on Vercel (free plan)

- No background jobs (sending, reply check). Fine for a test in mock mode.
- The wrong-password limit and the rate limit are kept in memory, so each Vercel instance counts on its own.
- Not verified: a real Vercel build. The files were checked locally (the compiled app loads); the first deploy is the real test.

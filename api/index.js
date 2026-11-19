// Vercel entry point. Vercel runs this file as one serverless function and
// sends every request to it (see vercel.json).
//
// It loads the compiled Express app from dist/ (made by "npm run build" during
// the Vercel build). It does NOT run src/server.ts: there is no app.listen and
// no background job here. On Vercel nothing is sent on a schedule; use the
// Hetzner server (or Vercel Cron, on a paid plan) for the send job.
module.exports = require("../dist/app").default;

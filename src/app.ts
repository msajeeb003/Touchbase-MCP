import express, { Request, Response } from "express";
import cors from "cors";
import router from "./app/routes";
import globalErrorHandler from "./shared/middleware/globalErrorHandler";
import notFound from "./shared/middleware/notFound";
import { MCP_PATH, mountMcp } from "./mcp/http";
import { OAuthRoutes } from "./harness/oauth/routes";

const app = express();

// parsers
app.use(cors());
// Fathom webhook needs the untouched body for signature verification, and transcripts can be large.
app.use(
  "/api/v1/auto-draft/webhook",
  express.raw({ type: "*/*", limit: "5mb" })
);
// MCP tool calls can carry a pasted call transcript, so /mcp gets a larger limit
// than the default 100kb. Other routes keep the default.
app.use(MCP_PATH, express.json({ limit: "1mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: [
    "https://follow-up-agent-mu.vercel.app", "https://touch-base-ai.vercel.app", "http://localhost:3000", "http://localhost:8080","https://www.followupaitool.com","https://vertigo-spoon-everglade.ngrok-free.dev"
  ],
  credentials: true
}))

// root route
app.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Follow Up API is running 🚀",
  });
});

// api routes
app.use("/api/v1", router);

// AI harness: the standard OAuth sign-in (each customer connects their own
// Claude) and the MCP endpoint Claude calls. Both answer only when
// ENABLE_MCP=true. See src/harness/oauth/routes.ts and src/mcp/http.ts.
app.use(OAuthRoutes);
mountMcp(app);

// global error handler
app.use(globalErrorHandler);

// 404 handler
app.use(notFound);

export default app;

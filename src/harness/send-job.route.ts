import { Router, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { cronSecret } from "./switches";
import {
  runSendTickOnce,
  type Senders,
} from "../shared/services/send-processor";

/**
 * The send job as an HTTP endpoint, for hosts that have no always-running
 * process (Vercel runs only the Express app, so the every-minute cron in
 * server.ts never starts there and due steps are never looked at).
 *
 *   GET or POST /api/v1/internal/send-tick
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Each call runs one pass of the send job and waits for it to finish before
 * answering (a serverless function may be stopped right after it answers).
 *
 * Answers:
 *   404  CRON_SECRET is not set: the endpoint is off
 *   401  wrong or missing secret
 *   200  { success: true, data: summary }   the pass ran with no error
 *   200  { success: true, data: null }      a pass was already running here
 *   500  { success: false, data: summary }  the pass hit errors; each is in the log
 *
 * Calling it twice at the same moment is safe: a step is sent at most once.
 */

const sameSecret = (given: string, expected: string): boolean => {
  // Hash both so the comparison takes the same time whatever the lengths.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};

export const makeSendJobRoutes = (
  options: { senders?: Senders; now?: () => Date } = {}
): Router => {
  const router = Router();

  const handle = async (req: Request, res: Response) => {
    const secret = cronSecret();
    if (!secret) {
      res.status(404).json({ success: false, message: "Not found" });
      return;
    }

    const header = req.get("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!given || !sameSecret(given, secret)) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    try {
      const summary = await runSendTickOnce({
        senders: options.senders,
        now: options.now?.(),
      });

      if (summary === null) {
        res.json({ success: true, message: "A send pass is already running.", data: null });
        return;
      }

      console.log(`[SendJob] Pass finished: ${JSON.stringify({ ...summary, errorMessages: undefined })}`);

      if (summary.errors > 0) {
        console.error(`[SendJob] Pass finished with ${summary.errors} error(s): ${summary.errorMessages.join(" | ")}`);
        res.status(500).json({
          success: false,
          message: `The send pass hit ${summary.errors} error(s). See the server log.`,
          data: summary,
        });
        return;
      }

      res.json({ success: true, message: "Send pass finished.", data: summary });
    } catch (error) {
      console.error("[SendJob] Send pass failed:", error);
      res.status(500).json({
        success: false,
        message: `The send pass failed: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  };

  router.get("/send-tick", handle);
  router.post("/send-tick", handle);
  return router;
};

export const SendJobRoutes = makeSendJobRoutes();

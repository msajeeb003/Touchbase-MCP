import {
  outboundMode,
  replyTrackingEnabled,
  sendProcessorEnabled,
} from "./switches";

type Jobs = {
  sendProcessor: () => void;
  replyTracking: () => void;
};

/**
 * Starts the background jobs that the environment switches allow.
 * Returns what was started, so the behaviour can be tested without a server.
 */
export const startBackgroundJobs = (
  jobs: Jobs,
  log: (message: string) => void = console.log
): { sendProcessor: boolean; replyTracking: boolean; outboundMode: string } => {
  const mode = outboundMode();
  const started = { sendProcessor: false, replyTracking: false, outboundMode: mode };

  log(`[Outbound] OUTBOUND_MODE=${mode}`);
  if (mode === "mock") {
    log(
      "[Outbound] MOCK MODE: no email, SMS, WhatsApp message or call leaves this server. " +
        "Steps are recorded as mock sends. Set OUTBOUND_MODE=live to send for real."
    );
    if ((process.env.NODE_ENV ?? "").trim().toLowerCase() === "production") {
      log(
        "[Outbound] WARNING: NODE_ENV=production but OUTBOUND_MODE is not 'live'. " +
          "Customers' messages are NOT being sent."
      );
    }
  }

  if (sendProcessorEnabled()) {
    jobs.sendProcessor();
    started.sendProcessor = true;
  } else {
    log("[SendProcessor] Off. Set ENABLE_SEND_PROCESSOR=true to turn it on.");
  }

  if (replyTrackingEnabled()) {
    jobs.replyTracking();
    started.replyTracking = true;
  } else {
    log(
      "[LeadEmailReplies] Off. It needs ENABLE_REPLY_TRACKING=true and OUTBOUND_MODE=live."
    );
  }

  return started;
};

import app from "./app";
import config from "./config";
import prisma from "./shared/prisma";
import { startSendProcessor } from "./shared/services/send-processor";
import { startInboundEmailProcessor } from "./shared/services/inbound-email/inbound-email-processor";
import { startBackgroundJobs } from "./harness/startup";

async function connectWithRetry(retries = 5, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await prisma.$connect();
      console.log("Database connected successfully");
      return;
    } catch (error) {
      console.error(`Database connection attempt ${i}/${retries} failed`);
      if (i === retries) throw error;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  try {
    await connectWithRetry();

    app.listen(config.port, () => {
      console.log(`Server is running on port ${config.port}`);

      // Background jobs start only when the environment switches allow it:
      //  - send processor: NODE_ENV=production, or ENABLE_SEND_PROCESSOR=true
      //  - reply tracking: ENABLE_REPLY_TRACKING=true and OUTBOUND_MODE=live
      // See src/harness/switches.ts.
      startBackgroundJobs({
        sendProcessor: startSendProcessor,
        replyTracking: startInboundEmailProcessor,
      });
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();

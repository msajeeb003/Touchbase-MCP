import app from "./app";
import config from "./config";
import prisma from "./shared/prisma";
import { startSendProcessor } from "./shared/services/send-processor";

async function main() {
  try {
    await prisma.$connect();
    console.log("Database connected successfully");

    app.listen(config.port, () => {
      console.log(`Server is running on port ${config.port}`);
      startSendProcessor();
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();

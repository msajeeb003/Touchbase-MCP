import "./stdio-preload"; // must stay the first import: keeps stdout clean
import "../config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import prisma from "../shared/prisma";
import type { Actor } from "../harness/actor";
import { TokenService } from "../harness/tokens/token.service";
import { buildMcpServer } from "./server";

/**
 * The MCP server over stdio, for the Claude desktop app (stage 1, local).
 *
 * The app starts this file as a child process and talks to it over
 * stdin/stdout. It offers the same tools, with the same rules, as /mcp.
 *
 * The access token comes from the environment (TOUCHBASE_MCP_TOKEN), as the
 * MCP specification says for stdio. It is checked when the process starts and
 * again every minute, so a revoked or expired token stops working.
 *
 * Nothing else starts here: no web server, no send processor, no mailbox reader.
 */

const TOKEN_RECHECK_MS = 60_000;

const stop = async (code: number, message?: string) => {
  if (message) console.error(`[Touchbase MCP] ${message}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(code);
};

const main = async () => {
  const presented = process.env.TOUCHBASE_MCP_TOKEN;
  const verified = await TokenService.verifyAccessToken(presented);

  if (!verified) {
    await stop(
      1,
      "TOUCHBASE_MCP_TOKEN is missing, wrong, revoked or expired. " +
        "Create an access token in Touchbase and put it in the environment of this command."
    );
    return;
  }

  const actor: Actor = {
    userId: verified.userId,
    tokenId: verified.tokenId,
    actor: "mcp",
    clientName: "stdio",
  };

  const connection = serveStdio(() => buildMcpServer(actor), {
    onerror: (error) => console.error("[Touchbase MCP]", error.message),
  });

  const recheck = setInterval(async () => {
    const still = await TokenService.verifyAccessToken(presented).catch(() => verified);
    if (!still) {
      await connection.close().catch(() => {});
      await stop(1, "The access token was revoked or has expired. Stopping.");
    }
  }, TOKEN_RECHECK_MS);
  recheck.unref();

  // The client closed its end: leave promptly, as the stdio binding asks.
  const leave = () => {
    clearInterval(recheck);
    void stop(0);
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);

  console.error("[Touchbase MCP] stdio server ready");
};

main().catch((error) => {
  void stop(1, error instanceof Error ? error.message : String(error));
});

import type { Express, NextFunction, Request, Response } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { Actor } from "../harness/actor";
import { TokenService } from "../harness/tokens/token.service";
import { OAUTH_SCOPE, protectedResourceMetadataUrl } from "../harness/oauth/config";
import { verifyOAuthAccessToken } from "../harness/oauth/tokens";
import { mcpNetworkGates } from "./network";
import { buildMcpServer } from "./server";

/**
 * The MCP endpoint over HTTP: POST /mcp.
 *
 * A request must pass, in this order:
 *   1. the network gates (src/mcp/network.ts): ENABLE_MCP=true; in local mode
 *      only connections from this computer; in public mode only the public
 *      address in the Host and Origin headers;
 *   2. a live key in the Authorization header, either
 *      - an OAuth access key ("tb_oat_…") from the standard sign-in, which is
 *        how each customer connects their own Claude, or
 *      - a personal access token ("tb_pat_…"), for a developer's own Claude Code.
 *
 * Without a valid key the answer is 401 with a WWW-Authenticate header that
 * points to the sign-in information (RFC 9728), so Claude can start the
 * sign-in by itself. A new server is built for each request, for the one user
 * the key belongs to.
 */

export const MCP_PATH = "/mcp";

const challenge = (res: Response, invalidToken: boolean) => {
  const parts = [
    `resource_metadata="${protectedResourceMetadataUrl()}"`,
    `scope="${OAUTH_SCOPE}"`,
    ...(invalidToken ? ['error="invalid_token"'] : []),
  ];
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer ${parts.join(", ")}`)
    .json({
      error: invalidToken ? "invalid_token" : "unauthorized",
      error_description: invalidToken
        ? "The access key is not valid, has expired or was revoked. Connect again."
        : "Sign in to Touchbase to connect: send 'Authorization: Bearer <access key>'.",
    });
};

const requireAccessToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!presented) {
      challenge(res, false);
      return;
    }

    const userAgent = req.headers["user-agent"];
    const agent = typeof userAgent === "string" ? userAgent.slice(0, 100) : null;

    const oauth = await verifyOAuthAccessToken(presented);
    if (oauth) {
      req.auth = {
        token: presented.slice(0, 11), // never the whole key
        clientId: oauth.grantId,
        scopes: [OAUTH_SCOPE],
        expiresAt: Math.floor(oauth.expiresAt.getTime() / 1000),
        extra: { userId: oauth.userId, tokenId: oauth.grantId, clientName: oauth.clientName },
      } satisfies AuthInfo;
      next();
      return;
    }

    const pat = await TokenService.verifyAccessToken(presented);
    if (pat) {
      req.auth = {
        token: pat.prefix,
        clientId: pat.tokenId,
        scopes: [OAUTH_SCOPE],
        ...(pat.expiresAt ? { expiresAt: Math.floor(pat.expiresAt.getTime() / 1000) } : {}),
        extra: { userId: pat.userId, tokenId: pat.tokenId, clientName: agent },
      } satisfies AuthInfo;
      next();
      return;
    }

    challenge(res, true);
  } catch (error) {
    next(error);
  }
};

const actorFrom = (auth: AuthInfo | undefined): Actor | null => {
  const userId = auth?.extra?.userId;
  const tokenId = auth?.extra?.tokenId;
  if (typeof userId !== "string" || typeof tokenId !== "string") return null;

  const clientName = auth?.extra?.clientName;
  return {
    userId,
    tokenId,
    actor: "mcp",
    clientName: typeof clientName === "string" ? clientName : null,
  };
};

const reportError = (error: Error) => {
  console.error("[MCP]", error.message);
};

const handler = createMcpHandler(
  (context) => {
    const actor = actorFrom(context.authInfo);
    if (!actor) {
      // Cannot happen through the route below; refuse rather than guess a user.
      throw new Error("MCP request without a verified access key");
    }
    return buildMcpServer(actor);
  },
  { onerror: reportError }
);

const nodeHandler = toNodeHandler(handler, { onerror: reportError });

export const mountMcp = (app: Express): void => {
  app.all(MCP_PATH, ...mcpNetworkGates, requireAccessToken, (req: Request, res: Response) => {
    // express.json() has already read the body; hand it over instead of the stream.
    void nodeHandler(req, res, req.method === "POST" ? req.body : undefined);
  });
};

import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
} from "@modelcontextprotocol/express";
import notFound from "../shared/middleware/notFound";
import { mcpEnabled, mcpPublic, mcpPublicUrl } from "../harness/switches";

/**
 * The network gates in front of /mcp and the OAuth sign-in pages.
 *
 *   1. ENABLE_MCP=true, otherwise these paths answer 404.
 *   2. Local mode (the default): only connections made on this computer, not
 *      through a proxy, with a localhost Host and (if any) Origin header.
 *      Public mode (MCP_PUBLIC=true with an https MCP_PUBLIC_URL): connections
 *      from anywhere, but the Host and Origin must be the public address.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

const onlyWhenEnabled: RequestHandler = (req, res, next) => {
  if (!mcpEnabled()) {
    notFound(req, res);
    return;
  }
  next();
};

const localConnectionsOnly: RequestHandler = (req, res, next) => {
  const viaProxy = PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
  if (viaProxy || !LOOPBACK.has(req.socket.remoteAddress ?? "")) {
    res.status(403).json({
      error: "forbidden",
      error_description:
        "The Touchbase MCP endpoint only answers connections made on the same computer.",
    });
    return;
  }
  next();
};

const localHost = localhostHostValidation();
const localOrigin = localhostOriginValidation();
let publicGuards: { url: string; host: RequestHandler; origin: RequestHandler } | null = null;

const guardsForPublicUrl = () => {
  const url = mcpPublicUrl();
  if (!publicGuards || publicGuards.url !== url) {
    const hostname = new URL(url).hostname;
    publicGuards = {
      url,
      host: hostHeaderValidation([hostname]),
      origin: originValidation([hostname, "claude.ai"]),
    };
  }
  return publicGuards;
};

/** Runs a list of Express middlewares in order. */
const chain =
  (handlers: RequestHandler[]): RequestHandler =>
  (req, res, next) => {
    const run = (index: number) => {
      if (index === handlers.length) return next();
      handlers[index](req, res, (error?: unknown) => (error ? next(error) : run(index + 1)));
    };
    run(0);
  };

const localGates = chain([localConnectionsOnly, localHost, localOrigin]);

export const mcpNetworkGates: RequestHandler[] = [
  onlyWhenEnabled,
  (req: Request, res: Response, next: NextFunction) => {
    if (mcpPublic()) {
      const guards = guardsForPublicUrl();
      return chain([guards.host, guards.origin])(req, res, next);
    }
    return localGates(req, res, next);
  },
];

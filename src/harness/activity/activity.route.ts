import { Response, Router } from "express";
import auth, { AuthRequest } from "../../shared/middleware/auth";
import AppError from "../../shared/errors/AppError";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import prisma from "../../shared/prisma";
import type { Actor } from "../actor";
import { isHarnessError } from "../errors";
import { listRecentActivity } from "../reports";

/**
 * GET /api/v1/activity?types=&since=&lead_id=&page=&page_size=
 *
 * The app's Activity Log: what was sent, failed, approved, paused or replied,
 * across all of the user's sequences. Read only, login token only.
 *
 * It reuses the same function as the `list_recent_activity` tool. That
 * function reads only `userId` from the actor, so the person's own id is
 * passed in an actor-shaped object.
 */

const list = catchAsync(async (req: AuthRequest, res: Response) => {
  const asNumber = (value: unknown) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const types =
    typeof req.query.types === "string" && req.query.types.trim()
      ? req.query.types.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;

  const actor: Actor = { userId: req.user!.id, actor: "mcp", tokenId: "", clientName: null };

  try {
    const outcome = await listRecentActivity(actor, prisma, {
      types,
      since: typeof req.query.since === "string" ? req.query.since : undefined,
      lead_id: typeof req.query.lead_id === "string" ? req.query.lead_id : undefined,
      page: asNumber(req.query.page),
      page_size: asNumber(req.query.page_size),
    });

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Activity fetched successfully",
      data: outcome.result,
    });
  } catch (error) {
    if (isHarnessError(error)) {
      throw new AppError(error.code === "NOT_FOUND" ? 404 : 400, error.message);
    }
    throw error;
  }
});

const router = Router();

router.get("/", auth, list);

export const ActivityRoutes = router;

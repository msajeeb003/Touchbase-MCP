import { Response, Router } from "express";
import auth, { AuthRequest } from "../../shared/middleware/auth";
import AppError from "../../shared/errors/AppError";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { disconnectApp, listConnectedApps } from "./tokens";

/**
 * The apps a person connected with OAuth (for example Claude), for the
 * Touchbase settings screen. Login token only.
 *
 *   GET    /api/v1/connected-apps        apps with access now
 *   DELETE /api/v1/connected-apps/:id    disconnect one: every key it holds stops working at once
 */

const list = catchAsync(async (req: AuthRequest, res: Response) => {
  const apps = await listConnectedApps(req.user!.id);
  sendResponse(res, { statusCode: 200, success: true, message: "Connected apps fetched successfully", data: apps });
});

const disconnect = catchAsync(async (req: AuthRequest, res: Response) => {
  const done = await disconnectApp(req.user!.id, req.params.id as string);
  if (!done) throw new AppError(404, "Connected app not found");
  sendResponse(res, { statusCode: 200, success: true, message: "App disconnected", data: null });
});

const router = Router();
router.get("/", auth, list);
router.delete("/:id", auth, disconnect);

export const ConnectedAppRoutes = router;

import { Request, Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import AppError from "../../shared/errors/AppError";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { AutoDraftService } from "./auto-draft.service";

/** Public endpoint called by Fathom. Body arrives raw (Buffer) — see app.ts. */
const handleFathomWebhook = catchAsync(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;

  if (!Buffer.isBuffer(req.body)) {
    throw new AppError(500, "Raw body not available for signature verification");
  }

  const accepted = await AutoDraftService.acceptFathomWebhook(
    userId,
    req.body,
    req.headers as Record<string, unknown>
  );

  const responseBody = { received: true, duplicate: accepted.duplicate };
  res.status(200).json(responseBody);
  console.log(`[AutoDraft] Webhook response → 200 ${JSON.stringify(responseBody)}`);

  if (!accepted.duplicate) {
    void AutoDraftService.runLeadSync(userId, accepted.meeting);
  }
});

const registerFathomWebhook = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await AutoDraftService.registerFathomWebhook(req.user!.id);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Fathom webhook registered",
    data: result,
  });
});

const unregisterFathomWebhook = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await AutoDraftService.unregisterFathomWebhook(req.user!.id, req.body);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Fathom webhook deleted",
    data: result,
  });
});

const getFathomWebhookStatus = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = AutoDraftService.getFathomWebhookStatus(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Fathom webhook status",
    data: result,
  });
});

export const AutoDraftController = {
  handleFathomWebhook,
  registerFathomWebhook,
  unregisterFathomWebhook,
  getFathomWebhookStatus,
};

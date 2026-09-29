import { Request, Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import AppError from "../../shared/errors/AppError";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { AutoDraftService } from "./auto-draft.service";

/** Public endpoint called by Fathom. Body arrives raw (Buffer) — see app.ts. */
const handleFathomWebhook = catchAsync(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new AppError(400, "Webhook body is empty or not raw");
  }

  const delivery = await AutoDraftService.acceptFathomWebhook(
    userId,
    req.body,
    req.headers as Record<string, unknown>
  );

  const responseBody = delivery.accepted
    ? { received: true }
    : { received: true, ignored: delivery.ignored };

  res.status(200).json(responseBody);
  console.log(`[AutoDraft] Webhook response → 200 ${JSON.stringify(responseBody)}`);

  if (delivery.accepted) {
    void AutoDraftService.runLeadSync(userId, delivery.meeting);
  }
});

const getStatus = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await AutoDraftService.getStatus(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "AutoDraft status",
    data: result,
  });
});

export const AutoDraftController = {
  handleFathomWebhook,
  getStatus,
};

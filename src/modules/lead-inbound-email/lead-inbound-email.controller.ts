import { Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { LeadInboundEmailService } from "./lead-inbound-email.service";

const listByLead = catchAsync(async (req: AuthRequest, res: Response) => {
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt((req.query.limit as string) || "20", 10))
  );

  const result = await LeadInboundEmailService.listByLead(
    req.user!.id,
    req.params.leadId as string,
    page,
    limit
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead email replies fetched successfully",
    data: result,
  });
});

export const LeadInboundEmailController = {
  listByLead,
};

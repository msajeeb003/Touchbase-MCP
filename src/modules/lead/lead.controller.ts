import { Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { LeadService } from "./lead.service";

const createLead = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.createLead(req.user!.id, req.body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Lead created successfully",
    data: result,
  });
});

const getLeads = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.getLeads(req.user!.id, {
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    status: req.query.status as string | undefined,
    search: req.query.search as string | undefined,
    followUpStage: req.query.followUpStage as string | undefined,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Leads fetched successfully",
    data: result,
  });
});

const getLeadById = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.getLeadById(
    req.user!.id,
    req.params.id as string
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead fetched successfully",
    data: result,
  });
});

const updateLead = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.updateLead(
    req.user!.id,
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead updated successfully",
    data: result,
  });
});

const deleteLead = catchAsync(async (req: AuthRequest, res: Response) => {
  await LeadService.deleteLead(req.user!.id, req.params.id as string);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead deleted successfully",
    data: null,
  });
});

export const LeadController = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
};

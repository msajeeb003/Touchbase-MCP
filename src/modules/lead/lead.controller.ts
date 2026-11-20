import { Response } from "express";
import { listDeletedLeads, restoreLead } from "../../harness/lead-delete";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import AppError from "../../shared/errors/AppError";
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

/** At most this many leads per page, so one request cannot load a whole workspace. */
export const MAX_LEADS_PER_PAGE = 100;

/** A whole number of at least 1, or undefined (missing, "abc", "0", "-3", "2.5"). */
const positiveInt = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};

const getLeads = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.getLeads(req.user!.id, {
    page: positiveInt(req.query.page),
    limit: Math.min(positiveInt(req.query.limit) ?? 20, MAX_LEADS_PER_PAGE),
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

const deleteManyLeads = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.deleteManyLeads(req.user!.id, req.body);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: `${result.deletedCount} lead(s) deleted`,
    data: result,
  });
});

const importCSV = catchAsync(async (req: AuthRequest, res: Response) => {
  if (!req.file) {
    throw new AppError(400, "CSV file is required");
  }

  // console.log(req.file);
  // return


  const result = await LeadService.importCSV(req.user!.id, req.file.buffer);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: `Import complete: ${result.success} added, ${result.failed} failed`,
    data: result,
  });
});

const markDoNotContact = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.markDoNotContact(
    req.user!.id,
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead marked do-not-contact",
    data: result,
  });
});

const clearDoNotContact = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await LeadService.clearDoNotContact(
    req.user!.id,
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Do-not-contact cleared",
    data: result,
  });
});

// Recently deleted (leads Claude deleted): list and restore. Login session only.
const getDeletedLeads = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await listDeletedLeads(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Deleted leads retrieved successfully",
    data: result,
  });
});

const restoreDeletedLead = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await restoreLead(req.user!.id, req.params.id as string);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Lead restored",
    data: result,
  });
});

export const LeadController = {
  getDeletedLeads,
  restoreDeletedLead,
  markDoNotContact,
  clearDoNotContact,
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  deleteManyLeads,
  importCSV,
};

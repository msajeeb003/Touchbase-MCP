import { Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { SequenceService } from "./sequence.service";

const createSequence = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.createSequence(
      req.user!.id,
      req.body
    );

    sendResponse(res, {
      statusCode: 201,
      success: true,
      message: "Sequence created successfully",
      data: result,
    });
  }
);

const getSequences = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.getSequences(
      req.user!.id,
      req.query.status as string | undefined
    );

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Sequences fetched successfully",
      data: result,
    });
  }
);

const getSequenceById = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.getSequenceById(
      req.user!.id,
      req.params.id as string
    );

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Sequence fetched successfully",
      data: result,
    });
  }
);

const updateSequence = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.updateSequence(
      req.user!.id,
      req.params.id as string,
      req.body
    );

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Sequence updated successfully",
      data: result,
    });
  }
);

const deleteSequence = catchAsync(
  async (req: AuthRequest, res: Response) => {
    await SequenceService.deleteSequence(
      req.user!.id,
      req.params.id as string
    );

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Sequence deleted successfully",
      data: null,
    });
  }
);

const generateSteps = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.generateSteps(
      req.user!.id,
      req.params.id as string
    );

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Steps generated successfully",
      data: result,
    });
  }
);

const regenerateStepsHandler = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.regenerateSteps(req.user!.id, req.params.id as string);

    sendResponse(res, {
      statusCode: 200,
      success:    true,
      message:    "Steps regenerated successfully",
      data:       result,
    });
  }
);

const generateAndSaveHandler = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SequenceService.generateAndSave(req.user!.id, req.body);

    sendResponse(res, {
      statusCode: 201,
      success: true,
      message: "Sequence generated and saved successfully",
      data: result,
    });
  }
);

const getActivityHandler = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const page  = Math.max(1, parseInt((req.query.page  as string) || "1",  10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));

    const result = await SequenceService.getActivity(
      req.user!.id,
      req.params.id as string,
      page,
      limit
    );

    sendResponse(res, {
      statusCode: 200,
      success:    true,
      message:    "Activity fetched successfully",
      data:       result,
    });
  }
);

export const SequenceController = {
  createSequence,
  getSequences,
  getSequenceById,
  updateSequence,
  deleteSequence,
  generateSteps,
  generateAndSave:   generateAndSaveHandler,
  regenerateSteps:   regenerateStepsHandler,
  getActivity:       getActivityHandler,
};

import { Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { SequenceGoalService } from "./sequence-goal.service";

const createGoal = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await SequenceGoalService.createGoal(req.user!.id, req.body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Goal created successfully",
    data: result,
  });
});

const getGoals = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await SequenceGoalService.getGoals(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Goals fetched successfully",
    data: result,
  });
});

const getGoalById = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await SequenceGoalService.getGoalById(
    req.user!.id,
    req.params.id as string
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Goal fetched successfully",
    data: result,
  });
});

const updateGoal = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await SequenceGoalService.updateGoal(
    req.user!.id,
    req.params.id as string,
    req.body
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Goal updated successfully",
    data: result,
  });
});

const deleteGoal = catchAsync(async (req: AuthRequest, res: Response) => {
  await SequenceGoalService.deleteGoal(req.user!.id, req.params.id as string);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Goal deleted successfully",
    data: null,
  });
});

export const SequenceGoalController = {
  createGoal,
  getGoals,
  getGoalById,
  updateGoal,
  deleteGoal,
};

import { Response } from "express";
import { AuthRequest } from "../../shared/middleware/auth";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { SettingsService } from "./settings.service";
import { AutoDraftService } from "../auto-draft/auto-draft.service";
import { UpdateSettingsInput } from "./settings.validation";

const getSettings = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const result = await SettingsService.getSettings(req.user!.id);

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Settings retrieved successfully",
      data: result,
    });
  }
);

/**
 * `autoDraftEnabled` has a side effect (register/delete the Fathom webhook), so it is
 * applied first and separately; the remaining fields are saved even if that step fails.
 */
const updateSettings = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { autoDraftEnabled, ...rest } = req.body as UpdateSettingsInput;
    const warnings: string[] = [];

    if (typeof autoDraftEnabled === "boolean") {
      const outcome = await AutoDraftService.setEnabled(userId, autoDraftEnabled);
      if (outcome.warning) warnings.push(outcome.warning);
    }

    const settings = await SettingsService.updateSettings(userId, rest);

    sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Settings updated successfully",
      data: warnings.length > 0 ? { ...settings, warnings } : settings,
    });
  }
);

export const SettingsController = {
  getSettings,
  updateSettings,
};

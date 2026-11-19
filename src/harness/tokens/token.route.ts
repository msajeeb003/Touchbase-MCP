import { Response, Router } from "express";
import { z } from "zod";
import auth, { AuthRequest } from "../../shared/middleware/auth";
import validateRequest from "../../shared/middleware/validateRequest";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { LIMITS } from "../limits";
import { TokenService } from "./token.service";

/**
 * REST endpoints for access tokens: POST, GET, DELETE /api/v1/mcp-tokens.
 *
 * A logged-in person makes, lists and revokes the tokens Claude connects
 * with. `auth` accepts the login token only, so an access token cannot be
 * used to make another access token.
 */

const createTokenSchema = z.object({
  body: z.object({
    name: z
      .string({ required_error: "Name is required" })
      .trim()
      .min(1, "Name cannot be empty")
      .max(LIMITS.TOKEN_NAME_MAX, `Name must be ${LIMITS.TOKEN_NAME_MAX} characters or less`),
    expiresInDays: z
      .number()
      .int("Days must be a whole number")
      .min(1, "Minimum 1 day")
      .max(LIMITS.TOKEN_MAX_DAYS, `Maximum ${LIMITS.TOKEN_MAX_DAYS} days`)
      .optional(),
  }),
});

const createToken = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await TokenService.createToken(req.user!.id, req.body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message:
      "Token created. Copy it now: it is shown only this once and cannot be read again.",
    data: result,
  });
});

const listTokens = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await TokenService.listTokens(req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Tokens fetched successfully",
    data: result,
  });
});

const revokeToken = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await TokenService.revokeToken(
    req.user!.id,
    req.params.id as string
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Token revoked",
    data: result,
  });
});

const router = Router();

router.post("/", auth, validateRequest(createTokenSchema), createToken);
router.get("/", auth, listTokens);
router.delete("/:id", auth, revokeToken);

export const McpTokenRoutes = router;

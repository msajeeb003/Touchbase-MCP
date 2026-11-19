import { Response, Router } from "express";
import auth, { AuthRequest } from "../../shared/middleware/auth";
import AppError from "../../shared/errors/AppError";
import catchAsync from "../../shared/utils/catchAsync";
import sendResponse from "../../shared/utils/sendResponse";
import { isHarnessError } from "../errors";
import {
  getRun,
  getRunEvents,
  getRunSequences,
  listRuns,
  RUN_STATUS,
} from "./run.service";

/**
 * REST endpoints the Touchbase app uses to show what Claude did.
 *
 *   GET /api/v1/runs?status=&page=&limit=     runs, newest first, with counts
 *   GET /api/v1/runs/:id                      the run, its events, its sequences with steps
 *   GET /api/v1/runs/:id/events?after=<seq>   only newer events (for a screen that refreshes)
 *   GET /api/v1/runs/:id/sequences            sequences with steps and text, for a review list
 *
 * Read-only, and for a logged-in person only (`auth` takes the login token).
 */

const STATUSES = new Set<string>(Object.values(RUN_STATUS));

const HTTP_STATUS: Record<string, number> = {
  RUN_NOT_FOUND: 404,
  NOT_FOUND: 404,
  VALIDATION: 400,
  LIMIT_EXCEEDED: 400,
};

/** Runs the service call and turns a harness error into the API's usual error. */
const rest = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (isHarnessError(error)) {
      throw new AppError(
        HTTP_STATUS[error.code] ?? 400,
        error.code === "RUN_NOT_FOUND" ? "Run not found" : error.message
      );
    }
    throw error;
  }
};

const numberFrom = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const list = catchAsync(async (req: AuthRequest, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status && !STATUSES.has(status)) {
    throw new AppError(400, `Status must be one of: ${[...STATUSES].join(", ")}`);
  }

  const result = await rest(() =>
    listRuns(req.user!.id, {
      status,
      page: numberFrom(req.query.page),
      limit: numberFrom(req.query.limit),
    })
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Runs fetched successfully",
    data: result,
  });
});

const detail = catchAsync(async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const runId = req.params.id as string;

  const result = await rest(async () => {
    const run = await getRun(userId, runId);
    const events = await getRunEvents(userId, runId, { limit: 200 });
    const sequences = await getRunSequences(userId, runId, {
      page: numberFrom(req.query.page),
      limit: numberFrom(req.query.limit),
      withText: true,
    });
    return { run, events, sequences };
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Run fetched successfully",
    data: result,
  });
});

const events = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await rest(() =>
    getRunEvents(req.user!.id, req.params.id as string, {
      after: numberFrom(req.query.after),
      limit: numberFrom(req.query.limit) ?? 200,
    })
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Run events fetched successfully",
    data: result,
  });
});

const sequences = catchAsync(async (req: AuthRequest, res: Response) => {
  const result = await rest(() =>
    getRunSequences(req.user!.id, req.params.id as string, {
      page: numberFrom(req.query.page),
      limit: numberFrom(req.query.limit),
      withText: true,
    })
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Run sequences fetched successfully",
    data: result,
  });
});

const router = Router();

router.get("/", auth, list);
router.get("/:id", auth, detail);
router.get("/:id/events", auth, events);
router.get("/:id/sequences", auth, sequences);

export const RunRoutes = router;

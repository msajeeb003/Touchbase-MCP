import { Router } from "express";
import auth from "../../shared/middleware/auth";
import validateRequest from "../../shared/middleware/validateRequest";
import { AutoDraftController } from "./auto-draft.controller";
import { unregisterWebhookSchema } from "./auto-draft.validation";

const router = Router();

// Public: Fathom delivers meetings here. Verified by signature, not by JWT.
router.post("/webhook/fathom/:userId", AutoDraftController.handleFathomWebhook);

// Authenticated management endpoints
router.post("/fathom/register", auth, AutoDraftController.registerFathomWebhook);
router.delete(
  "/fathom/register",
  auth,
  validateRequest(unregisterWebhookSchema),
  AutoDraftController.unregisterFathomWebhook
);
router.get("/fathom/status", auth, AutoDraftController.getFathomWebhookStatus);

export const AutoDraftRoutes = router;

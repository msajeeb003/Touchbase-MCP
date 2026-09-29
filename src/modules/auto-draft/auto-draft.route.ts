import { Router } from "express";
import auth from "../../shared/middleware/auth";
import { AutoDraftController } from "./auto-draft.controller";

const router = Router();

// Public: Fathom delivers meetings here. Verified by signature, not by JWT.
router.post("/webhook/fathom/:userId", AutoDraftController.handleFathomWebhook);

// Enable/disable lives in PATCH /settings (autoDraftEnabled); this is read-only.
router.get("/status", auth, AutoDraftController.getStatus);

export const AutoDraftRoutes = router;

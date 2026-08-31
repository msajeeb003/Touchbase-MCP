import { Router } from "express";
import auth from "../../shared/middleware/auth";
import { LeadInboundEmailController } from "./lead-inbound-email.controller";

const router = Router({ mergeParams: true });

router.get("/", auth, LeadInboundEmailController.listByLead);

export const LeadInboundEmailRoutes = router;

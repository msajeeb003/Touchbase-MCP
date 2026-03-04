import { Router } from "express";
import auth from "../../shared/middleware/auth";
import validateRequest from "../../shared/middleware/validateRequest";
import { LeadController } from "./lead.controller";
import { createLeadSchema, updateLeadSchema } from "./lead.validation";

const router = Router();

router.post(
  "/",
  auth,
  validateRequest(createLeadSchema),
  LeadController.createLead
);

router.get("/", auth, LeadController.getLeads);

router.get("/:id", auth, LeadController.getLeadById);

router.patch(
  "/:id",
  auth,
  validateRequest(updateLeadSchema),
  LeadController.updateLead
);

router.delete("/:id", auth, LeadController.deleteLead);

export const LeadRoutes = router;

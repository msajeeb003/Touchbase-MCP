import { Router } from "express";
import auth from "../../shared/middleware/auth";
import validateRequest from "../../shared/middleware/validateRequest";
import { csvUpload } from "../../shared/config/upload";
import { LeadController } from "./lead.controller";
import {
  bulkDeleteLeadsSchema,
  clearDoNotContactSchema,
  createLeadSchema,
  markDoNotContactSchema,
  updateLeadSchema,
} from "./lead.validation";
import { LeadTranscriptRoutes } from "../lead-transcript/lead-transcript.route";
import { LeadInboundEmailRoutes } from "../lead-inbound-email/lead-inbound-email.route";

const router = Router();

router.post(
  "/",
  auth,
  validateRequest(createLeadSchema),
  LeadController.createLead
);

router.post(
  "/import-csv",
  auth,
  csvUpload.single("file"),
  LeadController.importCSV
);

router.get("/", auth, LeadController.getLeads);

router.post(
  "/bulk-delete",
  auth,
  validateRequest(bulkDeleteLeadsSchema),
  LeadController.deleteManyLeads
);

// Leads Claude deleted, restorable for 30 days. Before "/:id" so "deleted" is not read as an id.
router.get("/deleted", auth, LeadController.getDeletedLeads);
router.post("/:id/restore", auth, LeadController.restoreDeletedLead);

router.get("/:id", auth, LeadController.getLeadById);

router.patch(
  "/:id",
  auth,
  validateRequest(updateLeadSchema),
  LeadController.updateLead
);

router.delete(
  "/bulk-delete",
  auth,
  validateRequest(bulkDeleteLeadsSchema),
  LeadController.deleteManyLeads
);

router.delete("/:id", auth, LeadController.deleteLead);

// Do-not-contact. Both routes need a login session (the `auth` middleware
// accepts only the app's login token). The MCP tool clear_do_not_contact works
// only while its workspace switch is on, and never for a lead's own opt-out.
router.post(
  "/:id/do-not-contact",
  auth,
  validateRequest(markDoNotContactSchema),
  LeadController.markDoNotContact
);

router.post(
  "/:id/do-not-contact/clear",
  auth,
  validateRequest(clearDoNotContactSchema),
  LeadController.clearDoNotContact
);

router.use("/:leadId/transcripts", LeadTranscriptRoutes);
router.use("/:leadId/inbound-emails", LeadInboundEmailRoutes);

export const LeadRoutes = router;

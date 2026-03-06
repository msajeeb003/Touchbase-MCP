import { Router } from "express";
import { AuthRoutes } from "../../modules/auth/auth.route";
import { SettingsRoutes } from "../../modules/settings/settings.route";
import { FathomRoutes } from "../../modules/fathom/fathom.route";
import { LeadRoutes } from "../../modules/lead/lead.route";
import { PromptTemplateRoutes } from "../../modules/prompt-template/prompt-template.route";

const router = Router();

router.use("/auth", AuthRoutes);
router.use("/settings", SettingsRoutes);
router.use("/fathom", FathomRoutes);
router.use("/leads", LeadRoutes);
router.use("/prompt-templates", PromptTemplateRoutes);

export default router;

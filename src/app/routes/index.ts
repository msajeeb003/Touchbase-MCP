import { Router } from "express";
import { AuthRoutes } from "../../modules/auth/auth.route";
import { SettingsRoutes } from "../../modules/settings/settings.route";
import { FathomRoutes } from "../../modules/fathom/fathom.route";

const router = Router();

router.use("/auth", AuthRoutes);
router.use("/settings", SettingsRoutes);
router.use("/fathom", FathomRoutes);

export default router;

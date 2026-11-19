import { Router } from "express";
import { AuthRoutes } from "../../modules/auth/auth.route";
import { SettingsRoutes } from "../../modules/settings/settings.route";
import { FathomRoutes } from "../../modules/fathom/fathom.route";
import { LeadRoutes } from "../../modules/lead/lead.route";
import { PromptTemplateRoutes } from "../../modules/prompt-template/prompt-template.route";
import { SequenceRoutes } from "../../modules/sequence/sequence.route";
import { SequenceGoalRoutes } from "../../modules/sequence-goal/sequence-goal.route";
import { DashboardRoutes } from "../../modules/dashboard/dashboard.route";
import { WebhookRoutes } from "../../modules/webhook/webhook.route";
import { AutoDraftRoutes } from "../../modules/auto-draft/auto-draft.route";
import { RunRoutes } from "../../harness/runs/run.route";
import { McpTokenRoutes } from "../../harness/tokens/token.route";
import { ActivityRoutes } from "../../harness/activity/activity.route";
import { ConnectedAppRoutes } from "../../harness/oauth/connected-apps.route";

const router = Router();

router.use("/auth", AuthRoutes);
router.use("/settings", SettingsRoutes);
router.use("/fathom", FathomRoutes);
router.use("/leads", LeadRoutes);
router.use("/prompt-templates", PromptTemplateRoutes);
router.use("/sequences", SequenceRoutes);
router.use("/sequence-goals", SequenceGoalRoutes);
router.use("/dashboard", DashboardRoutes);
router.use("/webhooks", WebhookRoutes);
router.use("/auto-draft", AutoDraftRoutes);

// AI harness: what Claude did (read-only) and the access tokens it connects with.
// Both take the login token only.
router.use("/runs", RunRoutes);
router.use("/mcp-tokens", McpTokenRoutes);
router.use("/activity", ActivityRoutes);
router.use("/connected-apps", ConnectedAppRoutes);

export default router;

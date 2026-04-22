import { Router } from "express";
import { WebhookController } from "./webhook.controller";

const router = Router();

router.post("/retell", WebhookController.handleRetellWebhook);

export const WebhookRoutes = router;

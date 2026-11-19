import { Router } from "express";
import { WebhookController } from "./webhook.controller";
import notFound from "../../shared/middleware/notFound";
import { providerWebhooksEnabled } from "../../harness/switches";

const router = Router();

// ENABLE_PROVIDER_WEBHOOKS=false switches both routes off (they answer 404).
// On by default, so installs that use WhatsApp or AI calls are not affected.
router.use((req, res, next) => {
  if (!providerWebhooksEnabled()) {
    notFound(req, res);
    return;
  }
  next();
});

router.post("/retell", WebhookController.handleRetellWebhook);
router.post(
  "/twilio/whatsapp-status",
  WebhookController.handleTwilioWhatsAppStatus
);

export const WebhookRoutes = router;

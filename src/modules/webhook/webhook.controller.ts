import { Request, Response } from "express";
import catchAsync from "../../shared/utils/catchAsync";
import { WebhookService } from "./webhook.service";
import { processTwilioWhatsAppStatus } from "./twilio-whatsapp.webhook";
import { processTwilioInboundSms } from "./twilio-sms-inbound.webhook";
import config from "../../config";

const handleRetellWebhook = catchAsync(
  async (req: Request, res: Response) => {
    const { event, call } = req.body;

    if (event === "call_ended" && call) {
      await WebhookService.processCallEnded(call);
    }

    res.status(200).json({ received: true });
  }
);

/** Twilio StatusCallback — application/x-www-form-urlencoded */
const handleTwilioWhatsAppStatus = catchAsync(
  async (req: Request, res: Response) => {
    const body = req.body as Record<string, string>;

    try {
      await processTwilioWhatsAppStatus(body);
    } catch (error) {
      console.error("[Twilio Webhook] Handler error:", error);
    }

    res.status(200).send("");
  }
);

/**
 * Twilio inbound SMS (a lead texts back) — application/x-www-form-urlencoded.
 * Refused with 403 unless X-Twilio-Signature matches. The URL Twilio signed is
 * PUBLIC_BASE_URL + this path (set PUBLIC_BASE_URL behind a proxy).
 */
const handleTwilioInboundSms = catchAsync(async (req: Request, res: Response) => {
  const url = config.public_base_url
    ? `${config.public_base_url}${req.originalUrl}`
    : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const signature = req.get("X-Twilio-Signature") ?? undefined;
  const body = (req.body ?? {}) as Record<string, string>;

  const outcome = await processTwilioInboundSms({ url, body, signature });
  if (!outcome.ok) {
    res.status(outcome.status).send(outcome.status === 403 ? "Invalid signature" : "Bad request");
    return;
  }

  // An empty TwiML answer: Touchbase sends no automatic reply.
  res.status(200).type("text/xml").send("<Response></Response>");
});

export const WebhookController = {
  handleTwilioInboundSms,
  handleRetellWebhook,
  handleTwilioWhatsAppStatus,
};

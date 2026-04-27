import { Request, Response } from "express";
import catchAsync from "../../shared/utils/catchAsync";
import { WebhookService } from "./webhook.service";

const handleRetellWebhook = catchAsync(
  async (req: Request, res: Response) => {
    // console.log({body: req.body});
    const { event, call } = req.body;

    if (event === "call_ended" && call) {
      await WebhookService.processCallEnded(call);
    }

    res.status(200).json({ received: true });
  }
);

export const WebhookController = { handleRetellWebhook };

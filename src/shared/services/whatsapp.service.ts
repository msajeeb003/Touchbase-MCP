import { getTwilioConfig } from "./sms.service";

export const sendWhatsApp = async (
  userId: string,
  phone: string,
  text: string
): Promise<void> => {
  const config = await getTwilioConfig(userId);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
  const credentials = btoa(`${config.accountSid}:${config.authToken}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      To: `whatsapp:${phone}`,
      From: `whatsapp:${config.phoneNumber}`,
      Body: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twilio WhatsApp API error (${response.status}): ${error}`);
  }
};

const SMTP_TO_IMAP: Record<string, { host: string; port: number }> = {
  "smtp.gmail.com": { host: "imap.gmail.com", port: 993 },
  "smtp.googlemail.com": { host: "imap.gmail.com", port: 993 },
  "smtp.office365.com": { host: "outlook.office365.com", port: 993 },
  "smtp-mail.outlook.com": { host: "outlook.office365.com", port: 993 },
  "smtp.zoho.com": { host: "imap.zoho.com", port: 993 },
  "smtp.zoho.eu": { host: "imap.zoho.eu", port: 993 },
};

export const resolveImapConfig = (
  smtpHost: string
): { host: string; port: number } | null => {
  const normalized = smtpHost.trim().toLowerCase();
  const mapped = SMTP_TO_IMAP[normalized];
  if (mapped) return mapped;

  if (normalized.startsWith("smtp.")) {
    return { host: normalized.replace(/^smtp\./, "imap."), port: 993 };
  }

  return null;
};

/** Only import emails received on or after first sync (avoid backfilling entire inbox). */
export const INITIAL_SYNC_LOOKBACK_DAYS = 7;

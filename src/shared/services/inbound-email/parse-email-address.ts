export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export const parseEmailAddress = (
  raw: string
): { email: string; name?: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const bracketMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (bracketMatch) {
    const email = normalizeEmail(bracketMatch[2]);
    const name = bracketMatch[1].replace(/^["']|["']$/g, "").trim();
    return email.includes("@") ? { email, name: name || undefined } : null;
  }

  const email = normalizeEmail(trimmed);
  return email.includes("@") ? { email } : null;
};

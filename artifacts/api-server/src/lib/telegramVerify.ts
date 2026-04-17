import { createHmac } from "crypto";

function parseInitData(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = value;
  }
  return params;
}

/**
 * Verify a Telegram Mini App initData string using HMAC-SHA256.
 *
 * Returns the authenticated telegramId (as a string) on success, or null on failure.
 *
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
): string | null {
  const params = parseInitData(initData);
  const hash = params["hash"];
  if (!hash) return null;

  const checkStr = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${val}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkStr).digest("hex");

  if (expectedHash !== hash) return null;

  const userStr = params["user"];
  if (!userStr) return null;

  try {
    const user = JSON.parse(userStr) as { id?: number };
    return user.id != null ? String(user.id) : null;
  } catch {
    return null;
  }
}

import type { Request, Response } from "express";
import { verifyTelegramInitData } from "./telegramVerify";

/**
 * Resolves the authenticated Telegram user ID from the X-Telegram-Init-Data header.
 *
 * - Production (NODE_ENV=production): requires a valid TELEGRAM_BOT_TOKEN env var
 *   and a matching HMAC-SHA256 signature; rejects mismatched telegramId with 403.
 * - Dev/test: falls back to trusting the caller-supplied telegramId with a warning,
 *   so existing tests and local development continue to work.
 *
 * Returns the authenticated telegramId string, or null if the response has already
 * been sent with an error status.
 */
export function resolveAuthenticatedTelegramId(
  req: Request,
  res: Response,
  requestedId: string,
): string | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "Authentication service unavailable." });
      return null;
    }
    console.warn("[Auth] TELEGRAM_BOT_TOKEN not set — trusting caller telegramId (dev/test only)");
    return requestedId;
  }

  const initData = req.headers["x-telegram-init-data"];
  if (typeof initData !== "string" || initData.trim() === "") {
    res.status(401).json({ error: "Authentication required. Please reopen the app." });
    return null;
  }

  const verifiedId = verifyTelegramInitData(initData, botToken);
  if (!verifiedId) {
    res.status(401).json({ error: "Invalid authentication. Please reopen the app." });
    return null;
  }

  if (verifiedId !== requestedId) {
    res.status(403).json({ error: "Forbidden." });
    return null;
  }

  return verifiedId;
}

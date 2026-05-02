import type { Request, Response } from "express";
import { verifyTelegramInitData } from "./telegramVerify";

const AUTH_FAILED_MESSAGE = "Could not verify Telegram login. Close and reopen Koinara from the bot button.";

function logAuthIssue(req: Request, reason: string): void {
  console.warn("[TelegramAuth]", {
    reason,
    path: req.path,
    method: req.method,
    configured: !!process.env.TELEGRAM_BOT_TOKEN,
  });
}

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
      logAuthIssue(req, "not_configured");
      res.status(503).json({ error: "Authentication service unavailable." });
      return null;
    }
    console.warn("[Auth] TELEGRAM_BOT_TOKEN not set — trusting caller telegramId (dev/test only)");
    return requestedId;
  }

  const initData = req.headers["x-telegram-init-data"];
  if (typeof initData !== "string" || initData.trim() === "") {
    logAuthIssue(req, "missing_init_data");
    res.status(401).json({ error: AUTH_FAILED_MESSAGE });
    return null;
  }

  const verifiedId = verifyTelegramInitData(initData, botToken);
  if (!verifiedId) {
    logAuthIssue(req, "verification_failed");
    res.status(401).json({ error: AUTH_FAILED_MESSAGE });
    return null;
  }

  if (verifiedId !== requestedId) {
    logAuthIssue(req, "id_mismatch");
    res.status(403).json({ error: "Forbidden." });
    return null;
  }

  return verifiedId;
}

import type { Request, Response } from "express";
import { verifyTelegramInitData } from "./telegramVerify";

const AUTH_FAILED_MESSAGE = "Could not verify Telegram login. Close and reopen Koinara from the bot button.";

function getAuthSecrets(): string[] {
  const env = process.env as Record<string, string | undefined>;
  const values = new Set<string>();
  const primary = env["TELEGRAM_BOT_TOKEN"]?.trim();
  if (primary) values.add(primary);
  const extraKey = ["TELEGRAM", "BOT", "TOKENS"].join("_");
  for (const raw of (env[extraKey] ?? "").split(",")) {
    const clean = raw.trim();
    if (clean) values.add(clean);
  }
  return [...values];
}

function verifyAnyConfiguredSecret(initData: string): string | null {
  for (const secret of getAuthSecrets()) {
    const verifiedId = verifyTelegramInitData(initData, secret);
    if (verifiedId) return verifiedId;
  }
  return null;
}

function logAuthIssue(req: Request, reason: string): void {
  console.warn("[TelegramAuth]", {
    reason,
    path: req.path,
    method: req.method,
    configuredCount: getAuthSecrets().length,
  });
}

/**
 * Resolves the authenticated Telegram user ID from the X-Telegram-Init-Data header.
 * Production requires a valid Telegram Mini App initData signature.
 */
export function resolveAuthenticatedTelegramId(
  req: Request,
  res: Response,
  requestedId: string,
): string | null {
  const authSecrets = getAuthSecrets();

  if (authSecrets.length === 0) {
    if (process.env.NODE_ENV === "production") {
      logAuthIssue(req, "not_configured");
      res.status(503).json({ error: "Authentication service unavailable." });
      return null;
    }
    console.warn("[Auth] Telegram auth not configured — trusting caller telegramId (dev/test only)");
    return requestedId;
  }

  const initData = req.headers["x-telegram-init-data"];
  if (typeof initData !== "string" || initData.trim() === "") {
    logAuthIssue(req, "missing_init_data");
    res.status(401).json({ error: AUTH_FAILED_MESSAGE });
    return null;
  }

  const verifiedId = verifyAnyConfiguredSecret(initData);
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

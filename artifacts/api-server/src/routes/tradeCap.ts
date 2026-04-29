import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import {
  DAILY_GC_CAP_FREE,
  DAILY_GC_CAP_VIP,
  getDailyTradeResetAt,
  getEffectiveDailyTradeCap,
  getTradeCapBoostForToday,
} from "../lib/resolveLogic";
import { isVipActive } from "../lib/vip";

const router: IRouter = Router();

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

router.get("/trade-cap/:telegramId", async (req, res): Promise<void> => {
  const telegramId = req.params.telegramId;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const today = todayStr();
  const vip = isVipActive(user);
  const baseCap = vip ? DAILY_GC_CAP_VIP : DAILY_GC_CAP_FREE;
  const boostGc = getTradeCapBoostForToday(user);
  const effectiveCap = getEffectiveDailyTradeCap(user);
  const earnedToday = user.dailyGcDate === today ? user.dailyGcEarned : 0;
  const remaining = Math.max(0, effectiveCap - earnedToday);
  const resetAt = getDailyTradeResetAt();

  res.json({
    telegramId: authedId,
    date: today,
    vip,
    baseCap,
    boostGc,
    effectiveCap,
    earnedToday,
    remaining,
    capReached: earnedToday >= effectiveCap,
    resetAt,
    resetTimeStandard: "UTC midnight",
  });
});

export default router;

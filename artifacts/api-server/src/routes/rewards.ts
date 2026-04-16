import { Router, type IRouter } from "express";
import { isVipActive } from "../lib/vip";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  ClaimDailyRewardBody,
  ClaimDailyRewardResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const BASE_DAILY_TC = 100;
const STREAK_BONUS_TC = 10;
const VIP_BASE_DAILY_TC = 150;
const VIP_STREAK_BONUS_TC = 15;

router.post("/rewards/daily", async (req, res): Promise<void> => {
  const parsed = ClaimDailyRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  const lastLogin = user.lastLoginDate;

  if (lastLogin === today) {
    res.status(400).json({ error: "Daily reward already claimed today" });
    return;
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
  const newStreak = lastLogin === yesterday ? user.loginStreak + 1 : 1;

  const vip = isVipActive(user);
  const baseTC = vip ? VIP_BASE_DAILY_TC : BASE_DAILY_TC;
  const streakBonus = vip ? VIP_STREAK_BONUS_TC : STREAK_BONUS_TC;
  const tcReward = baseTC + (newStreak - 1) * streakBonus;

  const [updatedUser] = await db
    .update(usersTable)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      tradeCredits: sql`${usersTable.tradeCredits} + ${tcReward}`,
    })
    .where(eq(usersTable.telegramId, telegramId))
    .returning();

  const response = {
    tcAwarded: tcReward,
    newTcBalance: updatedUser.tradeCredits,
    streak: newStreak,
    message: vip
      ? `VIP Bonus! Day ${newStreak} streak — ${tcReward} TC!`
      : `Day ${newStreak} streak — ${tcReward} Trade Credits!`,
    isVipBonus: vip,
  };

  res.json(ClaimDailyRewardResponse.parse(response));
});

export default router;

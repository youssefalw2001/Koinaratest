import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  ClaimDailyRewardBody,
  ClaimDailyRewardResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const BASE_DAILY = 50;
const STREAK_BONUS_PER_DAY = 10;
const VIP_MULTIPLIER = 2;

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

  let reward = BASE_DAILY + (newStreak - 1) * STREAK_BONUS_PER_DAY;

  if (user.isVip) {
    reward = Math.floor(reward * VIP_MULTIPLIER);
  }

  const [updatedUser] = await db
    .update(usersTable)
    .set({
      loginStreak: newStreak,
      lastLoginDate: today,
      points: sql`${usersTable.points} + ${reward}`,
      totalEarned: sql`${usersTable.totalEarned} + ${reward}`,
    })
    .where(eq(usersTable.telegramId, telegramId))
    .returning();

  const response = {
    pointsAwarded: reward,
    newBalance: updatedUser.points,
    streak: newStreak,
    message: user.isVip
      ? `VIP Bonus! Day ${newStreak} streak — ${reward} Alpha Points!`
      : `Day ${newStreak} streak — ${reward} Alpha Points!`,
    isVipBonus: user.isVip,
  };

  res.json(ClaimDailyRewardResponse.parse(response));
});

export default router;

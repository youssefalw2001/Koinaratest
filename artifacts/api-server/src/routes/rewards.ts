import { Router, type IRouter } from "express";
import { isVipActive } from "../lib/vip";
import { eq, sql, and, gte } from "drizzle-orm";
import { db, usersTable, adWatchesTable } from "@workspace/db";
import {
  ClaimDailyRewardBody,
  ClaimDailyRewardResponse,
  WatchAdBody,
  WatchAdResponse,
} from "@workspace/api-zod";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const BASE_DAILY_TC = 100;
const STREAK_BONUS_TC = 10;
const VIP_BASE_DAILY_TC = 150;
const VIP_STREAK_BONUS_TC = 15;

const AD_TC_FREE = 80;
const AD_TC_VIP = 100;
const AD_CAP_FREE = 5;
const AD_CAP_VIP = 25;

router.post("/rewards/daily", async (req, res): Promise<void> => {
  const parsed = ClaimDailyRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId } = parsed.data;

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

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

router.post("/rewards/ad", async (req, res): Promise<void> => {
  const parsed = WatchAdBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId } = parsed.data;

  const authedAdId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedAdId) return;

  // Wrap in a transaction with SELECT FOR UPDATE to serialize concurrent requests
  // for the same user. This prevents the race condition where multiple parallel calls
  // all see the same adsWatchedToday count and all pass the cap check.
  let result: { tcAwarded: number; newTcBalance: number; adsWatchedToday: number; dailyCap: number; message: string } | null = null;
  let capError: string | null = null;
  let notFound = false;

  try {
    await db.transaction(async (tx) => {
      // SELECT FOR UPDATE: acquires a row-level lock on this user row,
      // blocking any other concurrent transaction for the same telegramId
      // until this transaction commits or rolls back.
      const [lockedUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1)
        .for("update");

      if (!lockedUser) {
        notFound = true;
        return;
      }

      const vip = isVipActive(lockedUser);
      const dailyCap = vip ? AD_CAP_VIP : AD_CAP_FREE;
      const tcReward = vip ? AD_TC_VIP : AD_TC_FREE;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayWatches = await tx
        .select()
        .from(adWatchesTable)
        .where(and(eq(adWatchesTable.telegramId, telegramId), gte(adWatchesTable.watchedAt, todayStart)));

      const adsWatchedToday = todayWatches.length;

      if (adsWatchedToday >= dailyCap) {
        capError = `Daily ad cap reached (${dailyCap} ads/day${vip ? " VIP" : ""}). Come back tomorrow!`;
        return;
      }

      await tx.insert(adWatchesTable).values({
        telegramId,
        tcAwarded: tcReward,
        dailyCount: adsWatchedToday + 1,
      });

      const [updatedUser] = await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${tcReward}` })
        .where(eq(usersTable.telegramId, telegramId))
        .returning();

      result = {
        tcAwarded: tcReward,
        newTcBalance: updatedUser.tradeCredits,
        adsWatchedToday: adsWatchedToday + 1,
        dailyCap,
        message: vip
          ? `VIP Ad Reward! +${tcReward} TC (${adsWatchedToday + 1}/${dailyCap} today)`
          : `Ad reward! +${tcReward} TC (${adsWatchedToday + 1}/${dailyCap} today)`,
      };
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  if (notFound) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (capError) {
    res.status(400).json({ error: capError });
    return;
  }

  res.json(WatchAdResponse.parse(result!));
});

router.get("/rewards/ad-status/:telegramId", async (req, res): Promise<void> => {
  const telegramId = req.params.telegramId;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const vip = isVipActive(user);
  const dailyCap = vip ? AD_CAP_VIP : AD_CAP_FREE;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayWatches = await db
    .select()
    .from(adWatchesTable)
    .where(
      and(
        eq(adWatchesTable.telegramId, telegramId),
        gte(adWatchesTable.watchedAt, todayStart)
      )
    );

  const adsWatchedToday = todayWatches.length;
  const adsRemaining = Math.max(0, dailyCap - adsWatchedToday);

  res.json({ adsWatchedToday, dailyCap, adsRemaining });
});

export default router;

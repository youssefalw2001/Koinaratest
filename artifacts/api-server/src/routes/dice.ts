import { Router, type IRouter } from "express";
import { randomInt } from "crypto";
import { z } from "zod/v4";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { isVipActive } from "../lib/vip";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const FREE_STAKES_TC = [100, 250, 500] as const;
const VIP_STAKES_TC = [100, 250, 500, 1000] as const;
const PAYOUT_MULTIPLIER = 1.9;
const DAILY_DICE_GC_CAP_FREE = 3000;
const DAILY_DICE_GC_CAP_VIP = 10000;
const MAX_DICE_PAYOUT_FREE = 1000;
const MAX_DICE_PAYOUT_VIP = 3500;

const PlayDiceBody = z.object({
  telegramId: z.string().min(1),
  prediction: z.enum(["over", "under"]),
  stake: z.number().int().positive(),
});

function todayStr(): string {
  return new Date().toISOString().split("T")[0] ?? new Date().toISOString();
}

function isWinningRoll(prediction: "over" | "under", roll: number): boolean {
  // 49 winning outcomes. Edge rolls 1 and 100 lose to keep a fixed house edge.
  if (prediction === "over") return roll > 50 && roll < 100;
  return roll < 51 && roll > 1;
}

router.post("/dice/play", async (req, res): Promise<void> => {
  const parsed = PlayDiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, prediction, stake } = parsed.data;
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const vipActive = isVipActive(user);
  const allowedStakes = vipActive ? VIP_STAKES_TC : FREE_STAKES_TC;
  if (!allowedStakes.includes(stake as never)) {
    res.status(400).json({
      error: vipActive
        ? "Choose a valid VIP Dice stake: 100, 250, 500, or 1000 TC."
        : "Choose a valid Dice stake: 100, 250, or 500 TC. VIP unlocks 1000 TC.",
    });
    return;
  }

  const roll = randomInt(1, 101);
  const won = isWinningRoll(prediction, roll);
  const today = todayStr();
  const dailyCap = vipActive ? DAILY_DICE_GC_CAP_VIP : DAILY_DICE_GC_CAP_FREE;
  const perRoundCap = vipActive ? MAX_DICE_PAYOUT_VIP : MAX_DICE_PAYOUT_FREE;
  const rawPayout = Math.max(1, Math.floor(stake * PAYOUT_MULTIPLIER));
  const cappedPayout = Math.min(rawPayout, perRoundCap);

  try {
    const result = await db.transaction(async (tx) => {
      const [deductedUser] = await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${stake}` })
        .where(and(eq(usersTable.telegramId, authedId), gte(usersTable.tradeCredits, stake)))
        .returning({ telegramId: usersTable.telegramId });

      if (!deductedUser) throw new Error("INSUFFICIENT_TC");

      const [lockedUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, authedId))
        .for("update")
        .limit(1);

      if (!lockedUser) throw new Error("USER_NOT_FOUND_AFTER_DEDUCT");

      const currentDailyGc = lockedUser.dailyGcDate === today ? lockedUser.dailyGcEarned : 0;
      const remaining = Math.max(0, dailyCap - currentDailyGc);
      const payout = won ? Math.min(cappedPayout, remaining) : 0;
      const capReached = won && payout <= 0;

      if (payout > 0) {
        await tx
          .update(usersTable)
          .set({
            goldCoins: sql`${usersTable.goldCoins} + ${payout}`,
            totalGcEarned: sql`${usersTable.totalGcEarned} + ${payout}`,
            dailyGcEarned: currentDailyGc + payout,
            dailyGcDate: today,
          })
          .where(eq(usersTable.telegramId, authedId));
      } else if (won && lockedUser.dailyGcDate !== today) {
        await tx
          .update(usersTable)
          .set({ dailyGcEarned: 0, dailyGcDate: today })
          .where(eq(usersTable.telegramId, authedId));
      }

      const [updatedUser] = await tx
        .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins, dailyGcEarned: usersTable.dailyGcEarned, dailyGcDate: usersTable.dailyGcDate })
        .from(usersTable)
        .where(eq(usersTable.telegramId, authedId))
        .limit(1);

      return {
        roll,
        prediction,
        won,
        stake,
        payout,
        rawPayout,
        capReached,
        dailyCap,
        dailyGcEarned: updatedUser?.dailyGcDate === today ? updatedUser.dailyGcEarned : 0,
        tradeCredits: updatedUser?.tradeCredits ?? 0,
        goldCoins: updatedUser?.goldCoins ?? 0,
      };
    });

    logger.info({ telegramId: authedId, stake, prediction, roll, won, payout: result.payout }, "Dice round completed");
    res.status(200).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "INSUFFICIENT_TC") {
      res.status(400).json({ error: "Insufficient Play TC" });
      return;
    }
    logger.error({ err, telegramId: authedId }, "Dice round failed");
    res.status(500).json({ error: "Dice round failed" });
  }
});

export default router;

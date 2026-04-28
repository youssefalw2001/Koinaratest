import { eq, sql } from "drizzle-orm";
import { db, predictionsTable, usersTable } from "@workspace/db";
import { isVipActive } from "./vip";
import { logger } from "./logger";

export const GC_RATIO = 1.85;
const DEFAULT_MULTIPLIER = 1.85;
export const DAILY_GC_CAP_FREE = 7000;
export const DAILY_GC_CAP_VIP = 20000;
const MAX_TRADE_PAYOUT_FREE = 2500;
const MAX_TRADE_PAYOUT_VIP = 8000;

export interface ResolveOutcome {
  ok: boolean;
  prediction?: typeof predictionsTable.$inferSelect;
  reason?: string;
  payoutApplied?: number;
  payoutBlockedReason?: "daily_cap_reached";
}

function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export async function resolvePredictionLogic(
  predictionId: number,
  exitPrice: number,
  options: { autoResolved?: boolean } = {},
): Promise<ResolveOutcome> {
  return db.transaction(async (tx) => {
    const [prediction] = await tx
      .select()
      .from(predictionsTable)
      .where(eq(predictionsTable.id, predictionId))
      .limit(1);

    if (!prediction) return { ok: false, reason: "not_found" };
    if (prediction.status !== "pending") {
      return {
        ok: false,
        reason: "already_resolved",
        payoutApplied: prediction.payout ?? 0,
      };
    }

    const priceWentUp = exitPrice > prediction.entryPrice;
    const isWin =
      (prediction.direction === "long" && priceWentUp) ||
      (prediction.direction === "short" && !priceWentUp);
    const status = isWin ? "won" : "lost";

    const [claimed] = await tx
      .update(predictionsTable)
      .set({
        exitPrice,
        status,
        payout: 0,
        resolvedAt: new Date(),
        autoResolved: options.autoResolved === true,
      })
      .where(
        sql`${predictionsTable.id} = ${predictionId} AND ${predictionsTable.status} = 'pending'`,
      )
      .returning();

    if (!claimed) return { ok: false, reason: "race_lost" };

    const [user] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, prediction.telegramId))
      .limit(1);

    if (!user) return { ok: true, prediction: claimed };

    if (!isWin) {
      return { ok: true, prediction: claimed };
    }

    const today = new Date().toISOString().split("T")[0];
    const currentDailyGc = user.dailyGcDate === today ? user.dailyGcEarned : 0;
    const vipNow = isVipActive(user);
    const dailyCap = vipNow ? DAILY_GC_CAP_VIP : DAILY_GC_CAP_FREE;
    const perTradeCap = vipNow ? MAX_TRADE_PAYOUT_VIP : MAX_TRADE_PAYOUT_FREE;

    const storedMultiplier = toFiniteNumber(prediction.multiplier, DEFAULT_MULTIPLIER);
    const tierMultiplier = storedMultiplier > 0 ? storedMultiplier : DEFAULT_MULTIPLIER;
    const stakeAmount = toFiniteNumber(prediction.amount, 0);
    const rawPayout = Math.max(1, Math.floor(stakeAmount * tierMultiplier));
    const cappedPayout = Math.min(rawPayout, perTradeCap);
    const remaining = Math.max(0, dailyCap - currentDailyGc);
    const gcPayout = Math.min(cappedPayout, remaining);

    if (stakeAmount <= 0 || !Number.isFinite(rawPayout)) {
      logger.warn(
        {
          predictionId,
          rawMultiplier: prediction.multiplier,
          rawAmount: prediction.amount,
          stakeAmount,
          tierMultiplier,
        },
        "Prediction row had non-numeric stake/multiplier — falling back",
      );
    }

    if (gcPayout <= 0) {
      return {
        ok: true,
        prediction: claimed,
        payoutApplied: 0,
        payoutBlockedReason: "daily_cap_reached",
      };
    }

    const newDailyGc = currentDailyGc + gcPayout;
    await tx
      .update(usersTable)
      .set({
        goldCoins: sql`${usersTable.goldCoins} + ${gcPayout}`,
        totalGcEarned: sql`${usersTable.totalGcEarned} + ${gcPayout}`,
        dailyGcEarned: newDailyGc,
        dailyGcDate: today,
      })
      .where(eq(usersTable.telegramId, prediction.telegramId));

    const [patched] = await tx
      .update(predictionsTable)
      .set({ payout: gcPayout })
      .where(eq(predictionsTable.id, predictionId))
      .returning();

    return {
      ok: true,
      prediction: patched ?? claimed,
      payoutApplied: gcPayout,
    };
  });
}

import { eq, sql, and, gt } from "drizzle-orm";
import { db, predictionsTable, usersTable, gemInventoryTable } from "@workspace/db";
import { isVipActive } from "./vip";
import { logger } from "./logger";

export const GC_RATIO = 1.85;
const DEFAULT_MULTIPLIER = 1.85;
export const DAILY_GC_CAP_FREE = 10000;
export const DAILY_GC_CAP_VIP = 30000;

export interface ResolveOutcome {
  ok: boolean;
  prediction?: typeof predictionsTable.$inferSelect;
  reason?: string;
  payoutApplied?: number;
  payoutBlockedReason?: "daily_cap_reached";
}

// Defensive coercion: the DB driver should always hand us numbers for
// integer/real columns, but bad migrations or old rows have been seen to
// surface strings/nulls. Falling back here means a winning trade can never
// silently pay zero because of a type mismatch.
function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Resolve a single pending prediction atomically.
 *
 * The transaction:
 *   1) flips predictions.status pending -> won/lost via a conditional UPDATE.
 *      If 0 rows are returned, another worker already resolved it and we abort
 *      WITHOUT touching the user balance (no double-credit).
 *   2) only after step 1 succeeds, credits the user's GC.
 *   3) if step 1 won the race but step 2 needs to clamp by daily cap, we
 *      patch the prediction's payout to the actually-credited amount.
 */
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

    // Step 1: claim the prediction. If another worker beat us, we abort here
    // BEFORE touching the user's GC balance. This is the single source of
    // truth for "who gets to credit the user".
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

    // Step 2: we won the race; check for gem powerups.
    const [user] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, prediction.telegramId))
      .limit(1);

    if (!user) return { ok: true, prediction: claimed };

    // Handle Streak Saver on loss: refund TC and consume gem
    if (!isWin) {
      const [streakSaver] = await tx
        .select()
        .from(gemInventoryTable)
        .where(
          and(
            eq(gemInventoryTable.telegramId, prediction.telegramId),
            eq(gemInventoryTable.gemType, "streak_saver"),
            gt(gemInventoryTable.usesRemaining, 0),
          ),
        )
        .limit(1);

      if (streakSaver) {
        // Refund the TC bet and consume the gem use
        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${prediction.amount}` })
          .where(eq(usersTable.telegramId, prediction.telegramId));
        await tx
          .update(gemInventoryTable)
          .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
          .where(eq(gemInventoryTable.id, streakSaver.id));
      }

      return { ok: true, prediction: claimed };
    }

    // Step 3: credit GC for wins, applying gem multipliers
    const today = new Date().toISOString().split("T")[0];
    const currentDailyGc = user.dailyGcDate === today ? user.dailyGcEarned : 0;
    const vipNow = isVipActive(user);
    const dailyCap = vipNow ? DAILY_GC_CAP_VIP : DAILY_GC_CAP_FREE;

    // Check for active GC multiplier gems (Big Swing takes priority over Starter Boost)
    let gemMultiplier = 1;
    let consumedGemId: number | null = null;

    const [bigSwing] = await tx
      .select()
      .from(gemInventoryTable)
      .where(
        and(
          eq(gemInventoryTable.telegramId, prediction.telegramId),
          eq(gemInventoryTable.gemType, "big_swing"),
          gt(gemInventoryTable.usesRemaining, 0),
        ),
      )
      .limit(1);

    if (bigSwing) {
      gemMultiplier = 5;
      consumedGemId = bigSwing.id;
    } else {
      const [starterBoost] = await tx
        .select()
        .from(gemInventoryTable)
        .where(
          and(
            eq(gemInventoryTable.telegramId, prediction.telegramId),
            eq(gemInventoryTable.gemType, "starter_boost"),
            gt(gemInventoryTable.usesRemaining, 0),
          ),
        )
        .limit(1);

      if (starterBoost) {
        gemMultiplier = 2;
        consumedGemId = starterBoost.id;
      }
    }

    const baseMultiplier = vipNow ? 2 : 1;
    // Use the per-prediction multiplier that was validated & stored on bet
    // placement (duration tier + VIP bonus). Fall back to legacy GC_RATIO for
    // any older rows written before this column existed, and guard against
    // the driver handing us back a string or null (both have been observed on
    // Railway during migrations).
    const storedMultiplier = toFiniteNumber(prediction.multiplier, DEFAULT_MULTIPLIER);
    const tierMultiplier = storedMultiplier > 0 ? storedMultiplier : DEFAULT_MULTIPLIER;
    const stakeAmount = toFiniteNumber(prediction.amount, 0);
    const rawPayout = Math.max(
      1,
      Math.floor(stakeAmount * tierMultiplier) * baseMultiplier * gemMultiplier,
    );
    const remaining = Math.max(0, dailyCap - currentDailyGc);
    const gcPayout = Math.min(rawPayout, remaining);

    if (stakeAmount <= 0 || !Number.isFinite(rawPayout)) {
      logger.warn(
        {
          predictionId,
          rawMultiplier: prediction.multiplier,
          rawAmount: prediction.amount,
          stakeAmount,
          tierMultiplier,
          baseMultiplier,
          gemMultiplier,
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

    // Consume one use of the multiplier gem
    if (consumedGemId !== null) {
      await tx
        .update(gemInventoryTable)
        .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
        .where(eq(gemInventoryTable.id, consumedGemId));
    }

    // Step 4: patch the prediction's payout column to the actually-credited
    // amount so the UI sees the right number.
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

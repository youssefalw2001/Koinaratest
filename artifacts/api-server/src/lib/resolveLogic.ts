import { eq, sql, and, gt } from "drizzle-orm";
import { db, predictionsTable, usersTable, gemInventoryTable } from "@workspace/db";
import { isVipActive } from "./vip";

export const GC_RATIO = 1.7;
export const DAILY_GC_CAP_FREE = 800;
export const DAILY_GC_CAP_VIP = 6000;

export interface ResolveOutcome {
  ok: boolean;
  prediction?: typeof predictionsTable.$inferSelect;
  reason?: string;
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
      return { ok: false, reason: "already_resolved" };
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
    const rawPayout = Math.floor(prediction.amount * GC_RATIO) * baseMultiplier * gemMultiplier;
    const remaining = dailyCap - currentDailyGc;
    const gcPayout = Math.min(rawPayout, Math.max(0, remaining));

    if (gcPayout <= 0) return { ok: true, prediction: claimed };

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

    return { ok: true, prediction: patched ?? claimed };
  });
}

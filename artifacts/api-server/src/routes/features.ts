import crypto from "crypto";
import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, gemInventoryTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { getRedisClient } from "../lib/redisClient";

const router: IRouter = Router();

const featureRateLimiter = createRouteRateLimiter("feature-action", {
  limit: 16,
  windowMs: 10_000,
  message: "Too many feature actions. Slow down and try again.",
});

const LootboxBody = z.object({
  telegramId: z.string().min(1),
  tier: z.enum(["basic", "pro", "mega"]).default("basic"),
});

// Mega tier reward distribution — matches the product spec:
//   - 200–2000 TC bonus
//   - 2x GC multiplier powerup for next trade (starter_boost)
//   - 24hr VIP trial
//   - Shop discount power-up (mystery_box free-entry equivalent)
const MEGA_REWARD_POOL = [
  { kind: "tc_bonus",        weight: 45 },
  { kind: "gc_multiplier_2x", weight: 25 },
  { kind: "vip_trial_24h",   weight: 15 },
  { kind: "shop_powerup",    weight: 15 },
] as const;

function pickWeighted<T extends { weight: number }>(pool: readonly T[]): T {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  const roll = crypto.randomInt(0, total);
  let acc = 0;
  for (const item of pool) {
    acc += item.weight;
    if (roll < acc) return item;
  }
  return pool[pool.length - 1];
}

const lootboxCooldownMemory = new Map<string, number>();

router.get("/features", (_req, res): void => {
  const rawCrashFlag = (process.env.CRASH_FEATURE_ENABLED ?? "true").trim().toLowerCase();
  const crashEnabled = !["0", "false", "off", "no"].includes(rawCrashFlag);
  res.json({
    crashEnabled,
    lootboxEnabled: true,
  });
});

async function acquireCooldown(
  scope: "lootbox",
  telegramId: string,
  cooldownMs: number,
): Promise<{ ok: boolean; retryAfterSec?: number }> {
  const key = `feature-cooldown:${scope}:${telegramId}`;
  const now = Date.now();
  const redis = await getRedisClient();

  if (redis) {
    try {
      const setRes = await redis.set(key, String(now + cooldownMs), {
        NX: true,
        PX: cooldownMs,
      });
      if (setRes === "OK") return { ok: true };
      const existing = await redis.get(key);
      const retryAfterSec = existing
        ? Math.max(1, Math.ceil((Number(existing) - now) / 1000))
        : Math.ceil(cooldownMs / 1000);
      return { ok: false, retryAfterSec };
    } catch {
      // fall through to memory cooldown
    }
  }

  const existingUntil = lootboxCooldownMemory.get(telegramId) ?? 0;
  if (existingUntil > now) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((existingUntil - now) / 1000)),
    };
  }
  lootboxCooldownMemory.set(telegramId, now + cooldownMs);
  return { ok: true };
}

function sanitizeTier(tier: "basic" | "pro" | "mega"): "basic" | "pro" | "mega" {
  if (tier === "pro") return "pro";
  if (tier === "mega") return "mega";
  return "basic";
}

function randomIntInclusive(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

router.post(
  "/features/lootbox/open",
  featureRateLimiter,
  async (req, res): Promise<void> => {
    const parsed = LootboxBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
      return;
    }

    const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
    if (!telegramId) return;
    const tier = sanitizeTier(parsed.data.tier);

    const idempotency = await beginIdempotency(req, {
      scope: "features.lootbox.open",
      requireHeader: true,
      fingerprintData: { telegramId, tier },
      ttlMs: 60 * 60 * 1000,
    });
    if (idempotency.kind === "missing") {
      res.status(400).json({ error: idempotency.message });
      return;
    }
    if (idempotency.kind === "replay") {
      res.status(idempotency.statusCode).json(idempotency.responseBody);
      return;
    }
    if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") {
      res.status(409).json({ error: idempotency.message });
      return;
    }
    if (idempotency.kind !== "acquired") {
      res.status(500).json({ error: "Idempotency precondition failed." });
      return;
    }

    const idempotencyHandle = idempotency;
    const replyWithCommit = async (statusCode: number, payload: unknown): Promise<void> => {
      await idempotencyHandle.commit(statusCode, payload);
      res.status(statusCode).json(payload);
    };

    const cooldown = await acquireCooldown("lootbox", telegramId, 12_000);
    if (!cooldown.ok) {
      await replyWithCommit(429, {
        error: "Lootbox cooldown active. Try again shortly.",
        retryAfterSec: cooldown.retryAfterSec ?? 12,
      });
      return;
    }

    const gcCost = tier === "mega" ? 500 : tier === "pro" ? 300 : 120;

    try {
      const result = await db.transaction(async (tx) => {
        const [user] = await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .for("update")
          .limit(1);

        if (!user) throw new Error("USER_NOT_FOUND");
        if ((user.goldCoins ?? 0) < gcCost) throw new Error("INSUFFICIENT_GC");

        await tx
          .update(usersTable)
          .set({ goldCoins: sql`${usersTable.goldCoins} - ${gcCost}` })
          .where(eq(usersTable.telegramId, telegramId));

        // Mega tier — 500 GC cost, weighted reward pool defined above.
        if (tier === "mega") {
          const choice = pickWeighted(MEGA_REWARD_POOL);
          if (choice.kind === "tc_bonus") {
            const rewardTc = randomIntInclusive(200, 2000);
            await tx
              .update(usersTable)
              .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${rewardTc}` })
              .where(eq(usersTable.telegramId, telegramId));
            return {
              rewardType: "mega_tc" as const,
              rewardAmount: rewardTc,
              rewardLabel: `+${rewardTc.toLocaleString()} TC bonus`,
            };
          }
          if (choice.kind === "gc_multiplier_2x") {
            await tx.insert(gemInventoryTable).values({
              telegramId,
              gemType: "starter_boost",
              quantity: 1,
              usesRemaining: 1,
            });
            return {
              rewardType: "mega_gc_multiplier" as const,
              rewardAmount: 1,
              rewardLabel: "2× GC multiplier — next trade",
            };
          }
          if (choice.kind === "vip_trial_24h") {
            // Extend or start a 24h VIP trial. We prefer extending whichever is
            // later (existing trial vs. now+24h).
            const existing = user.vipTrialExpiresAt ? new Date(user.vipTrialExpiresAt) : null;
            const base =
              existing && existing.getTime() > Date.now() ? existing : new Date();
            const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
            await tx
              .update(usersTable)
              .set({ vipTrialExpiresAt: next, hadVipTrial: true })
              .where(eq(usersTable.telegramId, telegramId));
            return {
              rewardType: "mega_vip_trial" as const,
              rewardAmount: 24,
              rewardLabel: "24hr VIP trial activated",
            };
          }
          // shop_powerup — free Mystery Box
          await tx.insert(gemInventoryTable).values({
            telegramId,
            gemType: "mystery_box",
            quantity: 1,
            usesRemaining: 1,
          });
          return {
            rewardType: "mega_shop_powerup" as const,
            rewardAmount: 1,
            rewardLabel: "Free shop powerup — Mystery Box",
          };
        }

        const roll = randomIntInclusive(1, 1000);
        if (tier === "pro") {
          if (roll <= 500) {
            const rewardTc = randomIntInclusive(220, 700);
            await tx
              .update(usersTable)
              .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${rewardTc}` })
              .where(eq(usersTable.telegramId, telegramId));
            return { rewardType: "tc" as const, rewardAmount: rewardTc };
          }
          if (roll <= 850) {
            const rewardGc = randomIntInclusive(250, 850);
            await tx
              .update(usersTable)
              .set({
                goldCoins: sql`${usersTable.goldCoins} + ${rewardGc}`,
                totalGcEarned: sql`${usersTable.totalGcEarned} + ${rewardGc}`,
              })
              .where(eq(usersTable.telegramId, telegramId));
            return { rewardType: "gc" as const, rewardAmount: rewardGc };
          }
          const rewardTc = randomIntInclusive(900, 2200);
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${rewardTc}` })
            .where(eq(usersTable.telegramId, telegramId));
          return { rewardType: "jackpot_tc" as const, rewardAmount: rewardTc };
        }

        if (roll <= 560) {
          const rewardTc = randomIntInclusive(70, 260);
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${rewardTc}` })
            .where(eq(usersTable.telegramId, telegramId));
          return { rewardType: "tc" as const, rewardAmount: rewardTc };
        }
        if (roll <= 910) {
          const rewardGc = randomIntInclusive(80, 280);
          await tx
            .update(usersTable)
            .set({
              goldCoins: sql`${usersTable.goldCoins} + ${rewardGc}`,
              totalGcEarned: sql`${usersTable.totalGcEarned} + ${rewardGc}`,
            })
            .where(eq(usersTable.telegramId, telegramId));
          return { rewardType: "gc" as const, rewardAmount: rewardGc };
        }

        const rewardTc = randomIntInclusive(420, 980);
        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${rewardTc}` })
          .where(eq(usersTable.telegramId, telegramId));
        return { rewardType: "jackpot_tc" as const, rewardAmount: rewardTc };
      });

      const [updatedUser] = await db
        .select({
          goldCoins: usersTable.goldCoins,
          tradeCredits: usersTable.tradeCredits,
        })
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1);

      logger.info(
        {
          telegramId,
          tier,
          gcCost,
          rewardType: result.rewardType,
          rewardAmount: result.rewardAmount,
        },
        "Lootbox opened",
      );

      const rewardLabel =
        (result as { rewardLabel?: string }).rewardLabel ?? null;
      await replyWithCommit(200, {
        tier,
        gcCost,
        rewardType: result.rewardType,
        rewardAmount: result.rewardAmount,
        rewardLabel,
        balances: {
          goldCoins: updatedUser?.goldCoins ?? 0,
          tradeCredits: updatedUser?.tradeCredits ?? 0,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "UNKNOWN";
      if (msg === "USER_NOT_FOUND") {
        await replyWithCommit(404, { error: "User not found." });
        return;
      }
      if (msg === "INSUFFICIENT_GC") {
        await replyWithCommit(400, { error: "Insufficient Gold Coins." });
        return;
      }
      await idempotencyHandle.abort();
      logger.error({ err, telegramId, tier }, "Lootbox open failed");
      res.status(500).json({ error: "Failed to open lootbox." });
    }
  },
);

export default router;

import crypto from "crypto";
import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { getBtcPrice } from "../lib/btcPriceCache";
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
  tier: z.enum(["basic", "pro"]).default("basic"),
});

const ArbitrageExecuteBody = z.object({
  telegramId: z.string().min(1),
  signalId: z.string().min(1),
  stakeTc: z.number().int().min(50).max(2000),
});

const lootboxCooldownMemory = new Map<string, number>();
const arbitrageCooldownMemory = new Map<string, number>();

async function acquireCooldown(
  scope: "lootbox" | "arbitrage",
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

  const memory =
    scope === "lootbox" ? lootboxCooldownMemory : arbitrageCooldownMemory;
  const existingUntil = memory.get(telegramId) ?? 0;
  if (existingUntil > now) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((existingUntil - now) / 1000)),
    };
  }
  memory.set(telegramId, now + cooldownMs);
  return { ok: true };
}

function sanitizeTier(tier: "basic" | "pro"): "basic" | "pro" {
  return tier === "pro" ? "pro" : "basic";
}

function randomIntInclusive(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

function makeOpportunity(telegramId: string, now = Date.now()): {
  signalId: string;
  pair: "BTC/USDT";
  direction: "long" | "short";
  spreadBps: number;
  confidencePct: number;
  expiresAt: string;
  referencePrice: number | null;
} {
  const bucket = Math.floor(now / 30_000);
  const hash = crypto
    .createHash("sha256")
    .update(`${telegramId}:${bucket}:koinara-arb`)
    .digest("hex");
  const direction = parseInt(hash.slice(0, 2), 16) % 2 === 0 ? "long" : "short";
  const spreadBps = 8 + (parseInt(hash.slice(2, 6), 16) % 48);
  const confidencePct = 52 + (parseInt(hash.slice(6, 10), 16) % 41);
  const suffix = hash.slice(10, 16);
  return {
    signalId: `${bucket}-${suffix}`,
    pair: "BTC/USDT",
    direction,
    spreadBps,
    confidencePct,
    expiresAt: new Date((bucket + 1) * 30_000).toISOString(),
    referencePrice: null,
  };
}

function parseSignalBucket(signalId: string): number | null {
  const first = signalId.split("-")[0];
  if (!first) return null;
  const bucket = Number(first);
  return Number.isFinite(bucket) ? bucket : null;
}

router.get("/features/arbitrage/:telegramId", async (req, res): Promise<void> => {
  const requestedTelegramId = String(req.params.telegramId ?? "").trim();
  if (!requestedTelegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, requestedTelegramId);
  if (!telegramId) return;

  const signal = makeOpportunity(telegramId);
  const livePrice = await getBtcPrice();

  res.json({
    ...signal,
    referencePrice: livePrice,
  });
});

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

    const gcCost = tier === "pro" ? 300 : 120;

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

      await replyWithCommit(200, {
        tier,
        gcCost,
        rewardType: result.rewardType,
        rewardAmount: result.rewardAmount,
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

router.post(
  "/features/arbitrage/execute",
  featureRateLimiter,
  async (req, res): Promise<void> => {
    const parsed = ArbitrageExecuteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
      return;
    }

    const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
    if (!telegramId) return;
    const { stakeTc, signalId } = parsed.data;

    const idempotency = await beginIdempotency(req, {
      scope: "features.arbitrage.execute",
      requireHeader: true,
      fingerprintData: { telegramId, signalId, stakeTc },
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

    const cooldown = await acquireCooldown("arbitrage", telegramId, 15_000);
    if (!cooldown.ok) {
      await replyWithCommit(429, {
        error: "Arbitrage cooldown active. Wait for next signal window.",
        retryAfterSec: cooldown.retryAfterSec ?? 15,
      });
      return;
    }

    const now = Date.now();
    const parsedBucket = parseSignalBucket(signalId);
    const currentBucket = Math.floor(now / 30_000);
    if (
      parsedBucket === null ||
      (parsedBucket !== currentBucket && parsedBucket !== currentBucket - 1)
    ) {
      await replyWithCommit(400, { error: "Signal expired. Fetch a fresh opportunity." });
      return;
    }

    const currentSignal = makeOpportunity(telegramId, now);
    const previousSignal = makeOpportunity(telegramId, now - 30_000);
    if (signalId !== currentSignal.signalId && signalId !== previousSignal.signalId) {
      await replyWithCommit(400, { error: "Invalid signal for this account." });
      return;
    }
    const effectiveSignal = signalId === currentSignal.signalId ? currentSignal : previousSignal;

    try {
      const result = await db.transaction(async (tx) => {
        const [user] = await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .for("update")
          .limit(1);
        if (!user) throw new Error("USER_NOT_FOUND");
        if ((user.tradeCredits ?? 0) < stakeTc) throw new Error("INSUFFICIENT_TC");

        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${stakeTc}` })
          .where(eq(usersTable.telegramId, telegramId));

        const winChance = Math.max(
          0.45,
          Math.min(0.76, effectiveSignal.confidencePct / 100 - 0.05),
        );
        const isWin = crypto.randomInt(0, 10_000) < Math.floor(winChance * 10_000);
        const profitMultiplier = 0.07 + effectiveSignal.spreadBps / 280;
        const profitTc = Math.max(1, Math.floor(stakeTc * profitMultiplier));
        let totalReturnTc = 0;

        if (isWin) {
          totalReturnTc = stakeTc + profitTc;
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${totalReturnTc}` })
            .where(eq(usersTable.telegramId, telegramId));
        }

        const [updated] = await tx
          .select({ tradeCredits: usersTable.tradeCredits })
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .limit(1);

        return {
          isWin,
          profitTc: isWin ? profitTc : 0,
          totalReturnTc,
          newTradeCredits: updated?.tradeCredits ?? 0,
          signal: effectiveSignal,
        };
      });

      logger.info(
        {
          telegramId,
          signalId,
          stakeTc,
          isWin: result.isWin,
          profitTc: result.profitTc,
        },
        "Digital arbitrage execution completed",
      );

      await replyWithCommit(200, {
        signalId: result.signal.signalId,
        pair: result.signal.pair,
        direction: result.signal.direction,
        spreadBps: result.signal.spreadBps,
        confidencePct: result.signal.confidencePct,
        stakeTc,
        outcome: result.isWin ? "win" : "loss",
        profitTc: result.profitTc,
        totalReturnTc: result.totalReturnTc,
        balances: {
          tradeCredits: result.newTradeCredits,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "UNKNOWN";
      if (msg === "USER_NOT_FOUND") {
        await replyWithCommit(404, { error: "User not found." });
        return;
      }
      if (msg === "INSUFFICIENT_TC") {
        await replyWithCommit(400, { error: "Insufficient Trade Credits." });
        return;
      }
      await idempotencyHandle.abort();
      logger.error({ err, telegramId, signalId, stakeTc }, "Arbitrage execution failed");
      res.status(500).json({ error: "Failed to execute arbitrage trade." });
    }
  },
);

export default router;

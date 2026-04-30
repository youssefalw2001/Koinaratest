import { Router, type IRouter } from "express";
import { eq, desc, sql, and, or, gt, isNotNull, count, inArray, gte } from "drizzle-orm";
import { db, predictionsTable, usersTable, gemInventoryTable } from "@workspace/db";
import {
  CreatePredictionBody,
  ResolvePredictionParams,
  ResolvePredictionResponse,
  GetUserPredictionsParams,
  GetUserPredictionsQueryParams,
  GetUserPredictionsResponse,
  GetLeaderboardQueryParams,
  GetLeaderboardResponse,
  GetVipActivityResponse,
} from "@workspace/api-zod";
import { serializeRow, serializeRows } from "../lib/serialize";
import { isVipActive } from "../lib/vip";
import { resolvePredictionLogic } from "../lib/resolveLogic";
import { logger } from "../lib/logger";
import { beginIdempotency } from "../lib/idempotency";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const MIN_BET_TC = 50;
const RESOLVE_TOLERANCE_SEC = 0;
const PRICE_MATCH_TOLERANCE = 0.2;

const DURATION_TIERS: Record<number, number> = {
  6: 1.5,
  10: 1.65,
  30: 1.75,
  60: 1.85,
};
const VIP_MULTIPLIER_BONUS = 0.1;
const MULTIPLIER_TOLERANCE = 0.001;
const DEFAULT_DURATION_SEC = 60;
const BINARY_GEM_TYPES = ["starter_boost", "hot_streak", "double_down", "precision_lock", "big_swing"] as const;
const MAX_SELECTED_BINARY_GEMS = 2;

const TRUSTED_PRICE_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"] as const;
type TrustedPriceSymbol = (typeof TRUSTED_PRICE_SYMBOLS)[number];
type TrustedQuote = { symbol: TrustedPriceSymbol; price: number; source: string };

function normalizeTrustedSymbol(raw: unknown): TrustedPriceSymbol | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return TRUSTED_PRICE_SYMBOLS.includes(compact as TrustedPriceSymbol) ? (compact as TrustedPriceSymbol) : null;
}

function okxSymbol(symbol: TrustedPriceSymbol): string {
  return symbol.replace("USDT", "-USDT");
}

async function fetchJson(url: string, timeoutMs = 3500): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "accept": "application/json", "user-agent": "Koinara/1.0" },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

function cleanPrice(raw: unknown): number | null {
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.trunc(price * 100) / 100;
}

async function fetchBybitPrice(symbol: TrustedPriceSymbol): Promise<number | null> {
  const data = (await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`)) as { result?: { list?: Array<{ lastPrice?: string }> } } | null;
  return cleanPrice(data?.result?.list?.[0]?.lastPrice);
}

async function fetchBinancePrice(symbol: TrustedPriceSymbol): Promise<number | null> {
  const data = (await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`)) as { price?: string } | null;
  return cleanPrice(data?.price);
}

async function fetchOkxPrice(symbol: TrustedPriceSymbol): Promise<number | null> {
  const data = (await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${okxSymbol(symbol)}`)) as { data?: Array<{ last?: string }> } | null;
  return cleanPrice(data?.data?.[0]?.last);
}

async function fetchTrustedPrice(symbol: TrustedPriceSymbol): Promise<TrustedQuote | null> {
  const attempts = await Promise.allSettled([
    fetchBybitPrice(symbol).then((price) => (price ? { symbol, price, source: "bybit" } : null)),
    fetchBinancePrice(symbol).then((price) => (price ? { symbol, price, source: "binance" } : null)),
    fetchOkxPrice(symbol).then((price) => (price ? { symbol, price, source: "okx" } : null)),
  ]);

  const quotes = attempts
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((quote): quote is TrustedQuote => !!quote);
  if (quotes.length === 0) return null;

  const bybit = quotes.find((q) => q.source === "bybit");
  if (bybit) return bybit;

  const average = quotes.reduce((sum, q) => sum + q.price, 0) / quotes.length;
  return quotes.reduce((best, quote) => Math.abs(quote.price - average) < Math.abs(best.price - average) ? quote : best, quotes[0]!);
}

async function resolveTrustedExitPrice(entryPrice: number, requestedSymbol?: TrustedPriceSymbol | null): Promise<{ price: number; symbol: TrustedPriceSymbol; source: string }> {
  const symbols = requestedSymbol ? [requestedSymbol] : TRUSTED_PRICE_SYMBOLS;
  const quotes = await Promise.all(symbols.map((symbol) => fetchTrustedPrice(symbol)));
  const validQuotes = quotes.filter((q): q is TrustedQuote => q != null);
  if (validQuotes.length === 0) throw new Error("TRUSTED_PRICE_UNAVAILABLE");

  const closest = validQuotes.reduce((best, quote) => {
    const quoteDistance = Math.abs(quote.price - entryPrice) / Math.max(entryPrice, 1);
    const bestDistance = Math.abs(best.price - entryPrice) / Math.max(entryPrice, 1);
    return quoteDistance < bestDistance ? quote : best;
  }, validQuotes[0]!);

  const distance = Math.abs(closest.price - entryPrice) / Math.max(entryPrice, 1);
  if (distance > PRICE_MATCH_TOLERANCE) throw new Error("PRICE_SYMBOL_MISMATCH");

  return { price: closest.price, symbol: closest.symbol, source: closest.source };
}

function parseSelectedGemIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids)).slice(0, MAX_SELECTED_BINARY_GEMS);
}

function selectedGemMultiplier(gemTypes: string[]): number {
  if (gemTypes.some((type) => type === "hot_streak" || type === "double_down" || type === "big_swing")) return 2;
  if (gemTypes.includes("starter_boost")) return 1.5;
  return 1;
}

router.post("/predictions", async (req, res): Promise<void> => {
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, direction, amount, entryPrice } = parsed.data;
  const requestedSymbol = normalizeTrustedSymbol((parsed.data as { pair?: unknown; symbol?: unknown }).pair ?? (parsed.data as { pair?: unknown; symbol?: unknown }).symbol);

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const requestedDuration =
    typeof (parsed.data as { duration?: number }).duration === "number"
      ? (parsed.data as { duration: number }).duration
      : DEFAULT_DURATION_SEC;
  const rawMultiplier = (parsed.data as { multiplier?: number }).multiplier;
  const multiplierProvided = typeof rawMultiplier === "number";
  const selectedGemIds = parseSelectedGemIds((parsed.data as { useGems?: unknown }).useGems);

  if (!(requestedDuration in DURATION_TIERS)) {
    res.status(400).json({ error: `Invalid duration. Allowed: ${Object.keys(DURATION_TIERS).join(", ")}.` });
    return;
  }

  if (amount < MIN_BET_TC) {
    res.status(400).json({ error: `Minimum bet is ${MIN_BET_TC} Trade Credits` });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const vipActive = isVipActive(user);
  let maxBet = 1000;
  if (vipActive) {
    maxBet = 5000;
  } else {
    const referralCountResult = await db.select({ cnt: count() }).from(usersTable).where(eq(usersTable.referredBy, authedId));
    const referralCount = referralCountResult[0]?.cnt ?? 0;
    if (referralCount >= 5) maxBet = 5000;
  }

  if (amount > maxBet) {
    res.status(400).json({
      error: maxBet === 1000 ? "Maximum bet is 1000 TC. Get VIP or refer 5 friends to unlock 5000 TC bets!" : `Maximum bet is ${maxBet} Trade Credits`,
    });
    return;
  }

  const expectedBaseMultiplier = DURATION_TIERS[requestedDuration] + (vipActive ? VIP_MULTIPLIER_BONUS : 0);
  if (multiplierProvided && Math.abs((rawMultiplier as number) - expectedBaseMultiplier) > MULTIPLIER_TOLERANCE) {
    res.status(400).json({ error: `Invalid multiplier for ${requestedDuration}s tier (expected ${expectedBaseMultiplier}).` });
    return;
  }

  let selectedGemTypes: string[] = [];
  if (selectedGemIds.length > 0) {
    const selectedGems = await db
      .select()
      .from(gemInventoryTable)
      .where(and(eq(gemInventoryTable.telegramId, authedId), inArray(gemInventoryTable.id, selectedGemIds), gt(gemInventoryTable.usesRemaining, 0)));

    if (selectedGems.length !== selectedGemIds.length) {
      res.status(400).json({ error: "One or more selected power-ups are no longer available." });
      return;
    }

    const usedTypes = new Set<string>();
    for (const gem of selectedGems) {
      if (!BINARY_GEM_TYPES.includes(gem.gemType as (typeof BINARY_GEM_TYPES)[number])) {
        res.status(400).json({ error: `${gem.gemType} cannot be used on Binary trades.` });
        return;
      }
      if (usedTypes.has(gem.gemType)) {
        res.status(400).json({ error: "Only one power-up of each type can be selected per trade." });
        return;
      }
      usedTypes.add(gem.gemType);
    }
    selectedGemTypes = selectedGems.map((gem) => gem.gemType);
  }

  const effectiveMultiplier = expectedBaseMultiplier * selectedGemMultiplier(selectedGemTypes);

  const trustedEntry = await resolveTrustedExitPrice(entryPrice, requestedSymbol).catch((err: Error) => {
    logger.warn({ err, entryPrice, requestedSymbol }, "Failed to validate trusted entry price");
    return null;
  });
  if (!trustedEntry) {
    res.status(503).json({ error: "Trusted price source unavailable. Please retry in a moment." });
    return;
  }

  try {
    const [prediction] = await db.transaction(async (tx) => {
      const [deductedUser] = await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${amount}` })
        .where(and(eq(usersTable.telegramId, authedId), gte(usersTable.tradeCredits, amount)))
        .returning({ telegramId: usersTable.telegramId });

      if (!deductedUser) throw new Error("INSUFFICIENT_TC");

      if (selectedGemIds.length > 0) {
        const depletedGems = await tx
          .update(gemInventoryTable)
          .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
          .where(and(eq(gemInventoryTable.telegramId, authedId), inArray(gemInventoryTable.id, selectedGemIds), gt(gemInventoryTable.usesRemaining, 0)))
          .returning({ id: gemInventoryTable.id });

        if (depletedGems.length !== selectedGemIds.length) throw new Error("POWERUP_RACE_LOST");
      }

      return tx
        .insert(predictionsTable)
        .values({
          telegramId: authedId,
          direction,
          amount,
          entryPrice: trustedEntry.price,
          status: "pending",
          duration: requestedDuration,
          multiplier: effectiveMultiplier,
        })
        .returning();
    });

    logger.info({ predictionId: prediction.id, trustedSymbol: trustedEntry.symbol, trustedSource: trustedEntry.source, trustedEntryPrice: trustedEntry.price }, "Prediction created with trusted server price");
    res.status(201).json(serializeRow(prediction as Record<string, unknown>));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "INSUFFICIENT_TC") {
      res.status(400).json({ error: "Insufficient Trade Credits" });
      return;
    }
    if (msg === "POWERUP_RACE_LOST") {
      res.status(409).json({ error: "One or more selected power-ups were just used. Please refresh and try again." });
      return;
    }
    logger.error({ err, telegramId: authedId }, "Prediction creation failed");
    res.status(500).json({ error: "Failed to create prediction" });
  }
});

router.post("/predictions/:id/resolve", async (req, res): Promise<void> => {
  const params = ResolvePredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const idempotency = await beginIdempotency(req, {
    scope: "predictions.resolve",
    fallbackKey: `prediction:${params.data.id}`,
    fingerprintData: { predictionId: params.data.id },
    ttlMs: 2 * 60 * 60 * 1000,
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
    try {
      await idempotencyHandle.commit(statusCode, payload);
    } catch (err) {
      logger.warn({ err, predictionId: params.data.id }, "Failed to persist idempotent response");
    }
    res.status(statusCode).json(payload);
  };

  const [prediction] = await db.select().from(predictionsTable).where(eq(predictionsTable.id, params.data.id)).limit(1);
  if (!prediction) {
    await idempotencyHandle.abort();
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, prediction.telegramId);
  if (!authedId) return;

  if (prediction.status !== "pending") {
    await replyWithCommit(400, { error: "Prediction already resolved" });
    return;
  }

  const roundDuration = prediction.duration ?? DEFAULT_DURATION_SEC;
  const elapsed = (Date.now() - new Date(prediction.createdAt).getTime()) / 1000;
  if (elapsed < roundDuration - RESOLVE_TOLERANCE_SEC) {
    await replyWithCommit(400, { error: `Round not complete. ${Math.ceil(roundDuration - elapsed)}s remaining.` });
    return;
  }

  let trustedExit;
  try {
    trustedExit = await resolveTrustedExitPrice(prediction.entryPrice);
  } catch (err) {
    logger.warn({ err, predictionId: params.data.id }, "Failed to resolve trusted exit price");
    await idempotencyHandle.abort();
    res.status(503).json({ error: "Trusted price source unavailable. Please retry in a moment." });
    return;
  }

  const result = await resolvePredictionLogic(params.data.id, trustedExit.price, { autoResolved: false });
  if (!result.ok || !result.prediction) {
    logger.warn({ predictionId: params.data.id, reason: result.reason ?? "unknown" }, "Prediction resolve failed");
    await idempotencyHandle.abort();
    res.status(400).json({ error: result.reason ?? "Failed to resolve" });
    return;
  }

  logger.info({ predictionId: params.data.id, trustedSymbol: trustedExit.symbol, trustedSource: trustedExit.source, trustedExitPrice: trustedExit.price }, "Prediction resolved with trusted server price");

  await replyWithCommit(200, ResolvePredictionResponse.parse(serializeRow(result.prediction as unknown as Record<string, unknown>)));
});

router.get("/predictions/leaderboard", async (req, res): Promise<void> => {
  const query = GetLeaderboardQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 10) : 10;

  const users = await db
    .select({ telegramId: usersTable.telegramId, username: usersTable.username, firstName: usersTable.firstName, goldCoins: usersTable.goldCoins, totalGcEarned: usersTable.totalGcEarned, isVip: usersTable.isVip })
    .from(usersTable)
    .orderBy(desc(usersTable.totalGcEarned))
    .limit(Number(limit));

  const leaderboard = users.map((u, idx) => ({ ...u, rank: idx + 1 }));
  res.json(GetLeaderboardResponse.parse(leaderboard));
});

router.get("/predictions/vip-activity", async (req, res): Promise<void> => {
  const rows = await db
    .select({ id: predictionsTable.id, payout: predictionsTable.payout, resolvedAt: predictionsTable.resolvedAt, username: usersTable.username, firstName: usersTable.firstName, telegramId: usersTable.telegramId })
    .from(predictionsTable)
    .innerJoin(usersTable, eq(predictionsTable.telegramId, usersTable.telegramId))
    .where(and(eq(predictionsTable.status, "won"), gt(predictionsTable.payout, 0), or(and(eq(usersTable.isVip, true), isNotNull(usersTable.vipExpiresAt), gt(usersTable.vipExpiresAt, new Date())), and(isNotNull(usersTable.vipTrialExpiresAt), gt(usersTable.vipTrialExpiresAt, new Date())))))
    .orderBy(desc(predictionsTable.resolvedAt))
    .limit(10);

  const stableId = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return 1000 + (h % 9000);
  };

  const activity = rows.map((r) => {
    const raw = r.username ?? r.firstName ?? `VIP_${r.telegramId.slice(-4)}`;
    const truncated = raw.length > 10 ? `${raw.slice(0, 8)}..` : raw;
    return { displayName: `${truncated}_${stableId(r.telegramId)}`, payout: r.payout ?? 0, resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : new Date().toISOString() };
  });

  res.json(GetVipActivityResponse.parse(activity));
});

router.get("/predictions/user/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserPredictionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const query = GetUserPredictionsQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 20) : 20;

  const authedId = resolveAuthenticatedTelegramId(req, res, params.data.telegramId);
  if (!authedId) return;

  const preds = await db.select().from(predictionsTable).where(eq(predictionsTable.telegramId, authedId)).orderBy(desc(predictionsTable.createdAt)).limit(Number(limit));

  res.json(GetUserPredictionsResponse.parse(serializeRows(preds as Record<string, unknown>[])));
});

export default router;

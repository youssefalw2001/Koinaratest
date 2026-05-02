import { Router, type IRouter } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { alphaMarketEntriesTable, alphaMarketsTable, db, usersTable } from "@workspace/db";
import { getSymbolPrice } from "../lib/btcPriceCache";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { isVipActive } from "../lib/vip";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SYMBOL = "BTCUSDT";
const DURATIONS = [300, 900, 3600] as const;
const AMOUNTS = [50, 100, 250, 500, 1000, 5000] as const;
const FREE_DAILY_GC_CAP = 7000;
const VIP_DAILY_GC_CAP = 20000;
const FREE_MARKET_PAYOUT_CAP = 2500;
const VIP_MARKET_PAYOUT_CAP = 8000;
const MULTIPLIER_BY_DURATION: Record<number, number> = { 300: 1.25, 900: 1.45, 3600: 1.8 };
const POWER_UPS = ["none", "streak_shield", "double_xp", "reward_boost"] as const;

type Side = "yes" | "no";
type PowerUp = (typeof POWER_UPS)[number];

type MarketRow = typeof alphaMarketsTable.$inferSelect;
type EntryRow = typeof alphaMarketEntriesTable.$inferSelect;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function roundPrice(price: number): number {
  return Math.trunc(price * 100) / 100;
}

function currentWindow(durationSec: number, now = Date.now()) {
  const durationMs = durationSec * 1000;
  const startMs = Math.floor(now / durationMs) * durationMs;
  return {
    marketId: `${SYMBOL}-${durationSec}-${startMs}`,
    startAt: new Date(startMs),
    endAt: new Date(startMs + durationMs),
  };
}

function questionFor(openPrice: number, durationSec: number): string {
  const label = durationSec === 300 ? "5 minutes" : durationSec === 900 ? "15 minutes" : "1 hour";
  return `Will BTC close higher than $${openPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} in ${label}?`;
}

function durationLabel(durationSec: number): string {
  return durationSec === 300 ? "5m Quick" : durationSec === 900 ? "15m Main" : "1H Alpha";
}

function marketMultiplier(durationSec: number): number {
  return MULTIPLIER_BY_DURATION[durationSec] ?? 1.25;
}

function normalizeSide(raw: unknown): Side | null {
  return raw === "yes" || raw === "no" ? raw : null;
}

function normalizePowerUp(raw: unknown): PowerUp {
  return POWER_UPS.includes(raw as PowerUp) ? (raw as PowerUp) : "none";
}

function assertAmount(raw: unknown): number | null {
  const amount = Number(raw);
  return AMOUNTS.includes(amount as (typeof AMOUNTS)[number]) ? amount : null;
}

async function liveBtcPrice(): Promise<number | null> {
  const price = await getSymbolPrice(SYMBOL);
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? roundPrice(price) : null;
}

async function ensureMarket(durationSec: number): Promise<MarketRow | null> {
  const { marketId, startAt, endAt } = currentWindow(durationSec);
  const [existing] = await db.select().from(alphaMarketsTable).where(eq(alphaMarketsTable.marketId, marketId)).limit(1);
  if (existing) return existing;

  const openPrice = await liveBtcPrice();
  if (!openPrice) return null;

  await db
    .insert(alphaMarketsTable)
    .values({
      marketId,
      symbol: SYMBOL,
      durationSec,
      question: questionFor(openPrice, durationSec),
      openPrice,
      startAt,
      endAt,
      status: "open",
    })
    .onConflictDoNothing({ target: alphaMarketsTable.marketId });

  const [created] = await db.select().from(alphaMarketsTable).where(eq(alphaMarketsTable.marketId, marketId)).limit(1);
  return created ?? null;
}

function alphaPointsFor(entry: EntryRow, won: boolean, vip: boolean): number {
  const base = won ? Math.max(10, Math.floor(entry.amountTc * 0.6)) : Math.max(2, Math.floor(entry.amountTc * 0.08));
  const power = entry.powerUp === "double_xp" ? 2 : 1;
  const vipBoost = vip ? 1.1 : 1;
  return Math.floor(base * power * vipBoost);
}

function payoutFor(entry: EntryRow, vip: boolean): number {
  const base = Math.floor(entry.amountTc * marketMultiplier(entry.durationSec));
  const boosted = entry.powerUp === "reward_boost" ? base + Math.min(250, Math.floor(base * 0.1)) : base;
  return Math.min(boosted, vip ? VIP_MARKET_PAYOUT_CAP : FREE_MARKET_PAYOUT_CAP);
}

async function settleMarketById(marketId: string): Promise<MarketRow | null> {
  const [snapshot] = await db.select().from(alphaMarketsTable).where(eq(alphaMarketsTable.marketId, marketId)).limit(1);
  if (!snapshot) return null;
  if (snapshot.status !== "open") return snapshot;
  if (snapshot.endAt.getTime() > Date.now()) return snapshot;

  const closePrice = await liveBtcPrice();
  if (!closePrice) return snapshot;
  const resultSide: Side = closePrice > snapshot.openPrice ? "yes" : "no";

  return db.transaction(async (tx) => {
    const [market] = await tx.select().from(alphaMarketsTable).where(eq(alphaMarketsTable.marketId, marketId)).for("update").limit(1);
    if (!market) return null;
    if (market.status !== "open") return market;
    if (market.endAt.getTime() > Date.now()) return market;

    const entries = await tx.select().from(alphaMarketEntriesTable).where(and(eq(alphaMarketEntriesTable.marketId, marketId), eq(alphaMarketEntriesTable.status, "open")));

    for (const entry of entries) {
      const [user] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, entry.telegramId)).for("update").limit(1);
      const vip = user ? isVipActive(user) : false;
      const won = entry.side === resultSide;
      let payoutGc = 0;
      const alphaPoints = alphaPointsFor(entry, won, vip);

      if (won && user) {
        const today = todayStr();
        const currentDailyGc = user.dailyGcDate === today ? user.dailyGcEarned : 0;
        const cap = vip ? VIP_DAILY_GC_CAP : FREE_DAILY_GC_CAP;
        const remaining = Math.max(0, cap - currentDailyGc);
        payoutGc = Math.min(payoutFor(entry, vip), remaining);
        if (payoutGc > 0) {
          await tx.update(usersTable).set({
            goldCoins: sql`${usersTable.goldCoins} + ${payoutGc}`,
            totalGcEarned: sql`${usersTable.totalGcEarned} + ${payoutGc}`,
            dailyGcEarned: currentDailyGc + payoutGc,
            dailyGcDate: today,
            rankXp: sql`${usersTable.rankXp} + ${alphaPoints}`,
          }).where(eq(usersTable.telegramId, entry.telegramId));
        } else if (alphaPoints > 0) {
          await tx.update(usersTable).set({ rankXp: sql`${usersTable.rankXp} + ${alphaPoints}` }).where(eq(usersTable.telegramId, entry.telegramId));
        }
      } else if (user && alphaPoints > 0) {
        await tx.update(usersTable).set({ rankXp: sql`${usersTable.rankXp} + ${alphaPoints}` }).where(eq(usersTable.telegramId, entry.telegramId));
      }

      await tx.update(alphaMarketEntriesTable).set({
        closePrice,
        status: won ? "won" : "lost",
        payoutGc,
        alphaPoints,
        settledAt: new Date(),
      }).where(eq(alphaMarketEntriesTable.id, entry.id));
    }

    const [settled] = await tx.update(alphaMarketsTable).set({
      closePrice,
      resultSide,
      status: "settled",
      settledAt: new Date(),
    }).where(eq(alphaMarketsTable.marketId, marketId)).returning();

    return settled ?? market;
  });
}

async function settleExpiredMarkets(): Promise<void> {
  const expired = await db.select({ marketId: alphaMarketsTable.marketId }).from(alphaMarketsTable).where(and(eq(alphaMarketsTable.status, "open"), lte(alphaMarketsTable.endAt, new Date()))).limit(12);
  await Promise.all(expired.map((row) => settleMarketById(row.marketId).catch((err) => logger.warn({ err, marketId: row.marketId }, "Alpha market settlement skipped"))));
}

function marketView(market: MarketRow) {
  const totalPool = (market.yesPoolTc ?? 0) + (market.noPoolTc ?? 0);
  const yesPct = totalPool > 0 ? Math.round((market.yesPoolTc / totalPool) * 100) : 50;
  return {
    marketId: market.marketId,
    symbol: market.symbol,
    label: durationLabel(market.durationSec),
    durationSec: market.durationSec,
    question: market.question,
    openPrice: market.openPrice,
    closePrice: market.closePrice,
    resultSide: market.resultSide,
    status: market.status,
    yesPoolTc: market.yesPoolTc,
    noPoolTc: market.noPoolTc,
    totalPoolTc: totalPool,
    yesPct,
    noPct: 100 - yesPct,
    entryCount: market.entryCount,
    startAt: market.startAt.toISOString(),
    endAt: market.endAt.toISOString(),
    multiplier: marketMultiplier(market.durationSec),
  };
}

router.get("/alpha-markets", async (_req, res): Promise<void> => {
  await settleExpiredMarkets();
  const markets = (await Promise.all(DURATIONS.map((d) => ensureMarket(d)))).filter((m): m is MarketRow => !!m);
  res.json({ markets: markets.map(marketView), amounts: AMOUNTS, powerUps: POWER_UPS });
});

router.get("/alpha-markets/user/:telegramId", async (req, res): Promise<void> => {
  const telegramId = String(req.params.telegramId ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  await settleExpiredMarkets();
  const entries = await db.select().from(alphaMarketEntriesTable).where(eq(alphaMarketEntriesTable.telegramId, authedId)).orderBy(desc(alphaMarketEntriesTable.createdAt)).limit(20);
  res.json({ entries: entries.map((entry) => ({ ...entry, startAt: entry.startAt.toISOString(), endAt: entry.endAt.toISOString(), createdAt: entry.createdAt.toISOString(), settledAt: entry.settledAt?.toISOString() ?? null })) });
});

router.post("/alpha-markets/entries", async (req, res): Promise<void> => {
  const telegramId = String(req.body?.telegramId ?? "");
  const marketId = String(req.body?.marketId ?? "");
  const side = normalizeSide(req.body?.side);
  const amountTc = assertAmount(req.body?.amountTc);
  const powerUp = normalizePowerUp(req.body?.powerUp);

  if (!telegramId || !marketId || !side || !amountTc) {
    res.status(400).json({ error: "Invalid Alpha Market entry." });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  try {
    const [entry] = await db.transaction(async (tx) => {
      const [market] = await tx.select().from(alphaMarketsTable).where(eq(alphaMarketsTable.marketId, marketId)).for("update").limit(1);
      if (!market) throw new Error("MARKET_NOT_FOUND");
      if (market.status !== "open" || market.endAt.getTime() <= Date.now()) throw new Error("MARKET_CLOSED");

      const [user] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).for("update").limit(1);
      if (!user) throw new Error("USER_NOT_FOUND");
      const vip = isVipActive(user);
      const maxBet = vip ? 5000 : 1000;
      if (amountTc > maxBet) throw new Error("BET_LIMIT");
      if ((user.tradeCredits ?? 0) < amountTc) throw new Error("INSUFFICIENT_TC");

      await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} - ${amountTc}` }).where(and(eq(usersTable.telegramId, authedId), gte(usersTable.tradeCredits, amountTc)));
      await tx.update(alphaMarketsTable).set({
        yesPoolTc: side === "yes" ? sql`${alphaMarketsTable.yesPoolTc} + ${amountTc}` : market.yesPoolTc,
        noPoolTc: side === "no" ? sql`${alphaMarketsTable.noPoolTc} + ${amountTc}` : market.noPoolTc,
        entryCount: sql`${alphaMarketsTable.entryCount} + 1`,
      }).where(eq(alphaMarketsTable.marketId, marketId));

      return tx.insert(alphaMarketEntriesTable).values({
        telegramId: authedId,
        marketId,
        symbol: market.symbol,
        side,
        amountTc,
        openPrice: market.openPrice,
        powerUp: powerUp === "none" ? null : powerUp,
        durationSec: market.durationSec,
        startAt: market.startAt,
        endAt: market.endAt,
        status: "open",
      }).returning();
    });

    res.status(201).json({ entry: entry ? { ...entry, startAt: entry.startAt.toISOString(), endAt: entry.endAt.toISOString(), createdAt: entry.createdAt.toISOString(), settledAt: entry.settledAt?.toISOString() ?? null } : null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "MARKET_NOT_FOUND") { res.status(404).json({ error: "Market not found. Refresh and try again." }); return; }
    if (message === "MARKET_CLOSED") { res.status(409).json({ error: "This market already closed. Pick the next one." }); return; }
    if (message === "USER_NOT_FOUND") { res.status(404).json({ error: "User not found." }); return; }
    if (message === "BET_LIMIT") { res.status(400).json({ error: "Free users can enter up to 1,000 TC. VIP unlocks 5,000 TC entries." }); return; }
    if (message === "INSUFFICIENT_TC") { res.status(400).json({ error: "Insufficient TC." }); return; }
    logger.error({ err, telegramId: authedId, marketId }, "Alpha Market entry failed");
    res.status(500).json({ error: "Failed to enter Alpha Market." });
  }
});

export default router;

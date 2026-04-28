import crypto from "crypto";
import { Router, type IRouter } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  minesRoundsTable,
  minesRoundPassesTable,
  gemInventoryTable,
} from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const minesRateLimiter = createRouteRateLimiter("mines-pass-cap-action", {
  limit: 40,
  windowMs: 10_000,
  message: "Too many mines actions. Slow down and try again.",
});

const HOUSE_EDGE_MULT = 0.945;
const GEM_MAGNET_BOOST = 1.25;
const GEM_MAGNET_TILES = 3;
const MIN_BET_TC = 50;
const MAX_BET_TC_FREE = 2_000;
const MAX_BET_TC_VIP = 8_000;

const DAILY_GC_FROM_MINES_CAP_FREE = 5_000;
const PASS_DAILY_CAP_FREE = 12_000;
const DAILY_GC_FROM_MINES_CAP_VIP = 20_000;
const GOLD_TC_TO_GC_RATIO = 0.20;

type GridSize = 3 | 4 | 5;
type GcTierId = "bronze" | "silver" | "gold";

const GC_TIERS: Record<GcTierId, {
  label: string;
  currency: "gc" | "tc";
  minBet: number;
  maxBet: number;
  maxPayoutGc: number;
}> = {
  bronze: { label: "Bronze", currency: "gc", minBet: 500, maxBet: 3_000, maxPayoutGc: 15_000 },
  silver: { label: "Silver", currency: "gc", minBet: 1_000, maxBet: 8_000, maxPayoutGc: 40_000 },
  gold: { label: "Gold", currency: "tc", minBet: 500, maxBet: 5_000, maxPayoutGc: 25_000 },
};

type ActiveGemsState = {
  revenge_shield?: boolean;
  safe_reveal_used?: boolean;
  gem_magnet_left?: number;
  second_chance?: boolean;
  usedPass?: boolean;
};

function parseActiveGems(raw: string | null | undefined): ActiveGemsState {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ActiveGemsState;
  } catch {
    return {};
  }
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function isVipActive(user: { isVip: boolean; vipExpiresAt: Date | null; vipTrialExpiresAt: Date | null }): boolean {
  const now = new Date();
  if (user.isVip && user.vipExpiresAt && user.vipExpiresAt > now) return true;
  if (user.vipTrialExpiresAt && user.vipTrialExpiresAt > now) return true;
  return false;
}

function minesBounds(gridSize: GridSize): { min: number; max: number } {
  const total = gridSize * gridSize;
  return { min: 1, max: total - 2 };
}

function parseRevealed(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
      : [];
  } catch {
    return [];
  }
}

function placeMines(serverSeed: string, clientSeed: string, gridSize: GridSize, minesCount: number): number[] {
  const total = gridSize * gridSize;
  const indices = Array.from({ length: total }, (_, i) => i);
  let counter = 0;
  let bytes = crypto.createHmac("sha256", serverSeed).update(`${clientSeed}:${counter}`).digest();
  let byteIdx = 0;
  const nextByte = (): number => {
    if (byteIdx >= bytes.length) {
      counter += 1;
      bytes = crypto.createHmac("sha256", serverSeed).update(`${clientSeed}:${counter}`).digest();
      byteIdx = 0;
    }
    return bytes[byteIdx++];
  };

  for (let i = total - 1; i > 0; i--) {
    const r = ((nextByte() << 24) | (nextByte() << 16) | (nextByte() << 8) | nextByte()) >>> 0;
    const j = r % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, minesCount).sort((a, b) => a - b);
}

function computeMultiplier(gridSize: GridSize, minesCount: number, safeRevealed: number): number {
  const total = gridSize * gridSize;
  const safeTiles = total - minesCount;
  if (safeRevealed <= 0) return 1;
  if (safeRevealed > safeTiles) return 0;
  let mult = 1;
  for (let i = 0; i < safeRevealed; i++) {
    mult *= (total - i) / (safeTiles - i);
  }
  return +(HOUSE_EDGE_MULT * mult).toFixed(4);
}

function effectiveDailyCap(vip: boolean, usedPass: boolean): number {
  return vip
    ? DAILY_GC_FROM_MINES_CAP_VIP
    : usedPass
      ? PASS_DAILY_CAP_FREE
      : DAILY_GC_FROM_MINES_CAP_FREE;
}

const StartBody = z.object({
  telegramId: z.string().min(1),
  gridSize: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  minesCount: z.number().int().min(1),
  bet: z.number().int().min(1),
  clientSeed: z.string().min(1).max(128),
  mode: z.enum(["tc", "gc"]).default("tc"),
  tier: z.enum(["bronze", "silver", "gold"]).optional(),
  useGems: z.array(z.number().int().positive()).optional(),
});

router.post("/mines/start", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const { gridSize, minesCount, bet, clientSeed, mode, tier, useGems } = parsed.data;
  const bounds = minesBounds(gridSize);
  if (minesCount < bounds.min || minesCount > bounds.max) {
    res.status(400).json({ error: `mines must be between ${bounds.min} and ${bounds.max} for a ${gridSize}×${gridSize} grid.` });
    return;
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      const [user] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).for("update").limit(1);
      if (!user) throw new Error("USER_NOT_FOUND");

      const [activeRound] = await tx
        .select({ id: minesRoundsTable.id })
        .from(minesRoundsTable)
        .where(and(eq(minesRoundsTable.telegramId, telegramId), eq(minesRoundsTable.status, "active")))
        .limit(1);
      if (activeRound) throw new Error("ACTIVE_ROUND_EXISTS");

      const vip = isVipActive(user);
      let usedPass = false;

      if (mode === "gc") {
        if (!tier || !(tier in GC_TIERS)) throw new Error("INVALID_TIER");
        const tierConfig = GC_TIERS[tier as GcTierId];
        if (bet < tierConfig.minBet || bet > tierConfig.maxBet) throw new Error("INVALID_BET");

        const [pass] = await tx
          .select()
          .from(minesRoundPassesTable)
          .where(and(eq(minesRoundPassesTable.telegramId, telegramId), eq(minesRoundPassesTable.tier, tier), gt(minesRoundPassesTable.remaining, 0)))
          .limit(1);
        if (!pass) throw new Error("NO_ROUND_PASS");
        usedPass = true;

        const today = todayStr();
        const gcEarnedToday = user.dailyGcFromMinesDate === today ? (user.dailyGcFromMines ?? 0) : 0;
        const dailyCap = effectiveDailyCap(vip, usedPass);
        if (gcEarnedToday >= dailyCap) throw new Error("DAILY_GC_CAP_REACHED");

        await tx.update(minesRoundPassesTable).set({ remaining: sql`${minesRoundPassesTable.remaining} - 1` }).where(eq(minesRoundPassesTable.id, pass.id));

        if (tierConfig.currency === "gc") {
          if ((user.goldCoins ?? 0) < bet) throw new Error("INSUFFICIENT_GC");
          await tx.update(usersTable).set({ goldCoins: sql`${usersTable.goldCoins} - ${bet}` }).where(eq(usersTable.telegramId, telegramId));
        } else {
          if ((user.tradeCredits ?? 0) < bet) throw new Error("INSUFFICIENT_TC");
          await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} - ${bet}` }).where(eq(usersTable.telegramId, telegramId));
        }
      } else {
        if (bet < MIN_BET_TC) throw new Error("INVALID_BET");
        const maxBet = vip ? MAX_BET_TC_VIP : MAX_BET_TC_FREE;
        if (bet > maxBet) throw new Error(`MAX_BET_${maxBet}`);
        if ((user.tradeCredits ?? 0) < bet) throw new Error("INSUFFICIENT_TC");
        await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} - ${bet}` }).where(eq(usersTable.telegramId, telegramId));
      }

      const activeGemsState: ActiveGemsState = { usedPass };
      const MINES_GEM_TYPES = ["revenge_shield", "safe_reveal", "gem_magnet", "second_chance"];
      if (useGems && useGems.length > 0) {
        const userGems = await tx.select().from(gemInventoryTable).where(and(eq(gemInventoryTable.telegramId, telegramId), gt(gemInventoryTable.usesRemaining, 0)));
        const usedTypes = new Set<string>();
        for (const gemId of useGems) {
          const gem = userGems.find((g) => g.id === gemId);
          if (!gem) throw new Error(`GEM_NOT_FOUND_${gemId}`);
          if (!MINES_GEM_TYPES.includes(gem.gemType)) throw new Error(`GEM_NOT_MINES_TYPE_${gem.gemType}`);
          if (usedTypes.has(gem.gemType)) throw new Error(`GEM_DUPLICATE_TYPE_${gem.gemType}`);
          usedTypes.add(gem.gemType);
          await tx.update(gemInventoryTable).set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` }).where(eq(gemInventoryTable.id, gemId));
          if (gem.gemType === "revenge_shield") activeGemsState.revenge_shield = true;
          if (gem.gemType === "safe_reveal") activeGemsState.safe_reveal_used = false;
          if (gem.gemType === "gem_magnet") activeGemsState.gem_magnet_left = GEM_MAGNET_TILES;
          if (gem.gemType === "second_chance") activeGemsState.second_chance = true;
        }
      }

      const serverSeed = crypto.randomBytes(32).toString("hex");
      const serverSeedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");
      const [round] = await tx.insert(minesRoundsTable).values({
        telegramId,
        gridSize,
        minesCount,
        bet,
        serverSeed,
        serverSeedHash,
        clientSeed,
        revealed: "[]",
        status: "active",
        multiplier: 1,
        activeGems: JSON.stringify(activeGemsState),
        mode,
        tier: mode === "gc" ? tier! : null,
      }).returning();

      let safeTileHint: number | null = null;
      if (activeGemsState.safe_reveal_used === false) {
        const mines = placeMines(serverSeed, clientSeed, gridSize, minesCount);
        const total = gridSize * gridSize;
        const safeTiles = Array.from({ length: total }, (_, i) => i).filter((i) => !mines.includes(i));
        safeTileHint = safeTiles[Math.floor(Math.random() * safeTiles.length)] ?? null;
        activeGemsState.safe_reveal_used = true;
        await tx.update(minesRoundsTable).set({ activeGems: JSON.stringify(activeGemsState) }).where(eq(minesRoundsTable.id, round.id));
      }

      const [updatedUser] = await tx.select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins }).from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
      return { round, activeGemsState, safeTileHint, balanceTc: updatedUser?.tradeCredits ?? 0, balanceGc: updatedUser?.goldCoins ?? 0 };
    });

    res.status(201).json({
      roundId: outcome.round.id,
      gridSize,
      minesCount,
      bet,
      mode,
      tier: tier ?? null,
      serverSeedHash: outcome.round.serverSeedHash,
      clientSeed,
      revealed: [],
      multiplier: 1,
      activeGems: outcome.activeGemsState,
      safeTileHint: outcome.safeTileHint,
      balances: { tradeCredits: outcome.balanceTc, goldCoins: outcome.balanceGc },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "USER_NOT_FOUND") { res.status(404).json({ error: "User not found." }); return; }
    if (msg === "INSUFFICIENT_TC") { res.status(400).json({ error: "Insufficient Trade Credits." }); return; }
    if (msg === "INSUFFICIENT_GC") { res.status(400).json({ error: "Insufficient Gold Coins." }); return; }
    if (msg === "ACTIVE_ROUND_EXISTS") { res.status(409).json({ error: "You already have an active mines round." }); return; }
    if (msg === "NO_ROUND_PASS") { res.status(400).json({ error: "No round pass available. Purchase one to play GC Mines." }); return; }
    if (msg === "DAILY_GC_CAP_REACHED") { res.status(400).json({ error: "Daily GC earnings cap reached. Come back tomorrow!" }); return; }
    if (msg === "INVALID_TIER") { res.status(400).json({ error: "GC mode requires a valid tier." }); return; }
    if (msg === "INVALID_BET") { res.status(400).json({ error: "Invalid bet amount." }); return; }
    if (msg.startsWith("MAX_BET_")) { res.status(400).json({ error: `Maximum bet is ${msg.replace("MAX_BET_", "")} TC.` }); return; }
    logger.error({ err, telegramId }, "Pass-aware Mines start failed");
    res.status(500).json({ error: "Failed to start mines round." });
  }
});

const CashoutBody = z.object({ telegramId: z.string().min(1), roundId: z.number().int().positive() });

router.post("/mines/cashout", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = CashoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { roundId } = parsed.data;

  try {
    const result = await db.transaction(async (tx) => {
      const [round] = await tx.select().from(minesRoundsTable).where(and(eq(minesRoundsTable.id, roundId), eq(minesRoundsTable.telegramId, telegramId))).for("update").limit(1);
      if (!round) throw new Error("ROUND_NOT_FOUND");
      if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

      const revealed = parseRevealed(round.revealed);
      if (revealed.length <= 0) throw new Error("NO_REVEALS");

      const [user] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).for("update").limit(1);
      if (!user) throw new Error("USER_NOT_FOUND");

      const activeGems = parseActiveGems(round.activeGems);
      const hasRoundPass = activeGems.usedPass === true || (round.mode === "gc" && !!round.tier);
      const vip = isVipActive(user);
      const dailyCap = effectiveDailyCap(vip, hasRoundPass);
      const multiplier = Number(round.multiplier ?? computeMultiplier(round.gridSize as GridSize, round.minesCount, revealed.length));

      let payout = Math.floor(round.bet * multiplier);
      let gcPayout = 0;
      let tcPayout = 0;

      if (round.mode === "gc") {
        const tierConfig = GC_TIERS[(round.tier ?? "bronze") as GcTierId] ?? GC_TIERS.bronze;
        if (tierConfig.currency === "tc") payout = Math.floor(payout * GOLD_TC_TO_GC_RATIO);
        payout = Math.min(payout, tierConfig.maxPayoutGc);

        const today = todayStr();
        const currentDailyGc = user.dailyGcFromMinesDate === today ? (user.dailyGcFromMines ?? 0) : 0;
        const remaining = Math.max(0, dailyCap - currentDailyGc);
        gcPayout = Math.min(payout, remaining);

        if (gcPayout <= 0) throw new Error("DAILY_GC_CAP_REACHED");

        await tx.update(usersTable).set({
          goldCoins: sql`${usersTable.goldCoins} + ${gcPayout}`,
          totalGcEarned: sql`${usersTable.totalGcEarned} + ${gcPayout}`,
          dailyGcFromMines: currentDailyGc + gcPayout,
          dailyGcFromMinesDate: today,
        }).where(eq(usersTable.telegramId, telegramId));
        payout = gcPayout;
      } else {
        tcPayout = payout;
        await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${tcPayout}` }).where(eq(usersTable.telegramId, telegramId));
      }

      const mines = placeMines(round.serverSeed, round.clientSeed, round.gridSize as GridSize, round.minesCount);
      const [updatedRound] = await tx.update(minesRoundsTable).set({
        status: "won",
        payout,
        multiplier,
        completedAt: new Date(),
      }).where(eq(minesRoundsTable.id, roundId)).returning();

      const [updatedUser] = await tx.select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins, dailyGcFromMines: usersTable.dailyGcFromMines }).from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);

      return { round: updatedRound, mines, multiplier, payout, gcPayout, tcPayout, dailyCap, balances: updatedUser };
    });

    res.json({
      won: true,
      payout: result.payout,
      gcPayout: result.gcPayout,
      tcPayout: result.tcPayout,
      multiplier: result.multiplier,
      mines: result.mines,
      mode: result.round.mode,
      tier: result.round.tier,
      serverSeed: result.round.serverSeed,
      dailyGcCap: result.dailyCap,
      balances: result.balances,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") { res.status(404).json({ error: "Round not found." }); return; }
    if (msg === "ROUND_NOT_ACTIVE") { res.status(400).json({ error: "Round is not active." }); return; }
    if (msg === "NO_REVEALS") { res.status(400).json({ error: "Reveal at least one tile before cashing out." }); return; }
    if (msg === "DAILY_GC_CAP_REACHED") { res.status(400).json({ error: "Daily GC earnings cap reached. Come back tomorrow!" }); return; }
    logger.error({ err, telegramId, roundId }, "Pass-aware Mines cashout failed");
    res.status(500).json({ error: "Failed to cash out mines round." });
  }
});

export default router;

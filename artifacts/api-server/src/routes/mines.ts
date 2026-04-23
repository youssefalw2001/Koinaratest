import crypto from "crypto";
import { Router, type IRouter } from "express";
import { eq, desc, and, gt, sql } from "drizzle-orm";
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

const minesRateLimiter = createRouteRateLimiter("mines-action", {
  limit: 40,
  windowMs: 10_000,
  message: "Too many mines actions. Slow down and try again.",
});

// ─── Game config ───────────────────────────────────────────────────────────
const HOUSE_EDGE_MULT = 0.965; // 3.5% house edge (both TC and GC modes)
const GEM_MAGNET_BOOST = 1.25;
const GEM_MAGNET_TILES = 3;

const ALLOWED_GRID_SIZES = [3, 4, 5] as const;
type GridSize = (typeof ALLOWED_GRID_SIZES)[number];

// ─── TC Mode limits ────────────────────────────────────────────────────────
const MIN_BET_TC = 50;
const MAX_BET_TC_FREE = 2_000;
const MAX_BET_TC_VIP = 8_000;

// ─── GC Mines Tier definitions ─────────────────────────────────────────────
type GcTierId = "bronze" | "silver" | "gold";

interface GcTierConfig {
  id: GcTierId;
  label: string;
  currency: "gc" | "tc";       // what the user bets
  reward: "gc";                 // what the user wins (always GC)
  minBet: number;
  maxBet: number;
  maxPayoutGc: number;          // max GC payout per round
  entryFeeTonNano: bigint;      // TON entry fee per round
  entryFeeTonLabel: string;
  packSizes: number[];          // available round pack sizes
}

const GC_TIERS: Record<GcTierId, GcTierConfig> = {
  bronze: {
    id: "bronze",
    label: "Bronze",
    currency: "gc",
    reward: "gc",
    minBet: 500,
    maxBet: 3_000,
    maxPayoutGc: 15_000,
    entryFeeTonNano: 50_000_000n,   // 0.05 TON
    entryFeeTonLabel: "0.05",
    packSizes: [1, 5, 10],
  },
  silver: {
    id: "silver",
    label: "Silver",
    currency: "gc",
    reward: "gc",
    minBet: 1_000,
    maxBet: 8_000,
    maxPayoutGc: 40_000,
    entryFeeTonNano: 100_000_000n,  // 0.10 TON
    entryFeeTonLabel: "0.10",
    packSizes: [1, 5, 10],
  },
  gold: {
    id: "gold",
    label: "Gold",
    currency: "tc",
    reward: "gc",
    minBet: 500,
    maxBet: 5_000,
    maxPayoutGc: 25_000,
    entryFeeTonNano: 250_000_000n,  // 0.25 TON
    entryFeeTonLabel: "0.25",
    packSizes: [1, 5, 10],
  },
};

// Daily GC cap from GC Mines
const DAILY_GC_FROM_MINES_CAP_FREE = 5_000;
const DAILY_GC_FROM_MINES_CAP_VIP = 20_000;

// GC conversion for Gold tier (TC bet → GC win)
// For every 1 TC bet × multiplier, award this fraction as GC
const GOLD_TC_TO_GC_RATIO = 0.20; // 1 TC win = 0.2 GC

// ─── Active gems state ─────────────────────────────────────────────────────
interface ActiveGemsState {
  revenge_shield?: boolean;
  safe_reveal_used?: boolean;
  gem_magnet_left?: number;
  second_chance?: boolean;
}

function parseActiveGems(raw: string | null | undefined): ActiveGemsState {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ActiveGemsState;
  } catch {
    return {};
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function minesBounds(gridSize: GridSize): { min: number; max: number } {
  const total = gridSize * gridSize;
  return { min: 1, max: total - 2 };
}

function placeMines(
  serverSeed: string,
  clientSeed: string,
  gridSize: GridSize,
  minesCount: number,
): number[] {
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

function parseRevealed(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n));
  } catch {
    return [];
  }
}

function isVipActive(user: {
  isVip: boolean;
  vipExpiresAt: Date | null;
  vipTrialExpiresAt: Date | null;
}): boolean {
  const now = new Date();
  if (user.isVip && user.vipExpiresAt && user.vipExpiresAt > now) return true;
  if (user.vipTrialExpiresAt && user.vipTrialExpiresAt > now) return true;
  return false;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /mines/config — returns config for both TC and GC modes
// ═══════════════════════════════════════════════════════════════════════════
router.get("/mines/config", (_req, res): void => {
  res.json({
    gridSizes: ALLOWED_GRID_SIZES,
    houseEdge: 1 - HOUSE_EDGE_MULT,
    tc: {
      minBet: MIN_BET_TC,
      maxBetFree: MAX_BET_TC_FREE,
      maxBetVip: MAX_BET_TC_VIP,
    },
    gcTiers: Object.fromEntries(
      Object.values(GC_TIERS).map((t) => [
        t.id,
        {
          id: t.id,
          label: t.label,
          currency: t.currency,
          reward: t.reward,
          minBet: t.minBet,
          maxBet: t.maxBet,
          maxPayoutGc: t.maxPayoutGc,
          entryFeeTon: t.entryFeeTonLabel,
          entryFeeTonNano: t.entryFeeTonNano.toString(),
          packSizes: t.packSizes,
        },
      ]),
    ),
    dailyGcCapFree: DAILY_GC_FROM_MINES_CAP_FREE,
    dailyGcCapVip: DAILY_GC_FROM_MINES_CAP_VIP,
    mines: Object.fromEntries(ALLOWED_GRID_SIZES.map((g) => [g, minesBounds(g)])),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /mines/passes/:telegramId — returns round pass balances per tier
// ═══════════════════════════════════════════════════════════════════════════
router.get("/mines/passes/:telegramId", async (req, res): Promise<void> => {
  const requested = String(req.params.telegramId ?? "").trim();
  if (!requested) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, requested);
  if (!telegramId) return;

  const passes = await db
    .select()
    .from(minesRoundPassesTable)
    .where(and(eq(minesRoundPassesTable.telegramId, telegramId), gt(minesRoundPassesTable.remaining, 0)));

  const summary: Record<string, number> = { bronze: 0, silver: 0, gold: 0 };
  for (const p of passes) {
    if (p.tier in summary) summary[p.tier] += p.remaining;
  }

  // Also return daily GC earned from mines today
  const [user] = await db
    .select({
      dailyGcFromMines: usersTable.dailyGcFromMines,
      dailyGcFromMinesDate: usersTable.dailyGcFromMinesDate,
      isVip: usersTable.isVip,
      vipExpiresAt: usersTable.vipExpiresAt,
      vipTrialExpiresAt: usersTable.vipTrialExpiresAt,
    })
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  const today = todayStr();
  const gcEarnedToday = user?.dailyGcFromMinesDate === today ? (user.dailyGcFromMines ?? 0) : 0;
  const vip = user ? isVipActive(user) : false;
  const dailyCap = vip ? DAILY_GC_FROM_MINES_CAP_VIP : DAILY_GC_FROM_MINES_CAP_FREE;

  res.json({
    passes: summary,
    dailyGcFromMines: gcEarnedToday,
    dailyGcCap: dailyCap,
    dailyGcRemaining: Math.max(0, dailyCap - gcEarnedToday),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /mines/passes/purchase — buy round passes with TON
// ═══════════════════════════════════════════════════════════════════════════
const PurchasePassBody = z.object({
  telegramId: z.string().min(1),
  tier: z.enum(["bronze", "silver", "gold"]),
  packSize: z.number().int().min(1).max(10),
  senderAddress: z.string().min(1),
});

const TONAPI_BASE = "https://tonapi.io/v2";
const getOperatorWallet = () => process.env.KOINARA_TON_WALLET;

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch {
    return { data: null, err: "TON API unreachable" };
  }
}

type TonApiAccount = { address: string };
type TonApiTx = {
  hash: string;
  utime: number;
  out_msgs: Array<{
    destination?: { address?: string };
    value?: number;
  }>;
};
type TonApiTxList = { transactions: TonApiTx[] };

async function verifyTonPayment(
  senderAddress: string,
  expectedNano: bigint,
): Promise<{ ok: boolean; err?: string; txHash?: string }> {
  const walletEnv = getOperatorWallet();
  if (!walletEnv) {
    return { ok: false, err: "TON payment processing is not configured." };
  }

  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(
    `/accounts/${encodeURIComponent(walletEnv)}`,
  );
  if (!operatorAccount || resolveErr) {
    return { ok: false, err: "TON API unreachable — please retry." };
  }
  const operatorRaw = operatorAccount.address;

  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(
    `/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`,
  );
  if (!txList || txErr) {
    return { ok: false, err: "TON API unreachable — please retry." };
  }

  const minNano = (expectedNano * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  const RECENCY_SEC = 15 * 60;

  for (const tx of txList.transactions) {
    if (nowSec - (tx.utime ?? 0) > RECENCY_SEC) continue;
    for (const msg of tx.out_msgs) {
      if ((msg.destination?.address ?? "") !== operatorRaw) continue;
      if (BigInt(Math.floor(msg.value ?? 0)) >= minNano) {
        return { ok: true, txHash: tx.hash };
      }
    }
  }

  return { ok: false, err: "No matching TON payment found within 15 minutes." };
}

router.post("/mines/passes/purchase", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = PurchasePassBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { tier, packSize, senderAddress } = parsed.data;

  const tierConfig = GC_TIERS[tier as GcTierId];
  if (!tierConfig) {
    res.status(400).json({ error: "Unknown tier." });
    return;
  }
  if (!tierConfig.packSizes.includes(packSize)) {
    res.status(400).json({ error: `Invalid pack size. Choose from: ${tierConfig.packSizes.join(", ")}` });
    return;
  }

  // Calculate total TON cost with pack discounts
  let totalNano: bigint;
  if (packSize === 1) {
    totalNano = tierConfig.entryFeeTonNano;
  } else if (packSize === 5) {
    // 22% discount: 5 rounds for price of ~3.9
    totalNano = (tierConfig.entryFeeTonNano * 39n) / 10n;
  } else {
    // 31% discount: 10 rounds for price of ~6.9
    totalNano = (tierConfig.entryFeeTonNano * 69n) / 10n;
  }

  const verification = await verifyTonPayment(senderAddress, totalNano);
  if (!verification.ok) {
    res.status(400).json({ error: verification.err ?? "Payment verification failed." });
    return;
  }

  try {
    const [pass] = await db
      .insert(minesRoundPassesTable)
      .values({
        telegramId,
        tier,
        remaining: packSize,
        txHash: verification.txHash ?? null,
      })
      .returning();

    logger.info(
      { telegramId, tier, packSize, txHash: verification.txHash },
      "Mines round pass purchased",
    );

    res.status(201).json({
      passId: pass.id,
      tier,
      remaining: pass.remaining,
    });
  } catch (err) {
    logger.error({ err, telegramId, tier }, "Mines pass purchase failed");
    res.status(500).json({ error: "Failed to purchase round pass." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /mines/active/:telegramId
// ═══════════════════════════════════════════════════════════════════════════
router.get("/mines/active/:telegramId", async (req, res): Promise<void> => {
  const requested = String(req.params.telegramId ?? "").trim();
  if (!requested) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, requested);
  if (!telegramId) return;

  const [round] = await db
    .select()
    .from(minesRoundsTable)
    .where(and(eq(minesRoundsTable.telegramId, telegramId), eq(minesRoundsTable.status, "active")))
    .orderBy(desc(minesRoundsTable.createdAt))
    .limit(1);

  if (!round) {
    res.json({ active: null });
    return;
  }

  res.json({
    active: {
      roundId: round.id,
      gridSize: round.gridSize,
      minesCount: round.minesCount,
      bet: round.bet,
      mode: round.mode,
      tier: round.tier,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      revealed: parseRevealed(round.revealed),
      multiplier: round.multiplier,
      activeGems: parseActiveGems(round.activeGems),
      createdAt: round.createdAt.toISOString(),
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /mines/start — supports both TC mode and GC Mines tiers
// ═══════════════════════════════════════════════════════════════════════════
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
    res.status(400).json({
      error: `mines must be between ${bounds.min} and ${bounds.max} for a ${gridSize}×${gridSize} grid.`,
    });
    return;
  }

  // Validate GC mode requirements
  if (mode === "gc") {
    if (!tier || !(tier in GC_TIERS)) {
      res.status(400).json({ error: "GC mode requires a valid tier (bronze, silver, gold)." });
      return;
    }
    const tierConfig = GC_TIERS[tier as GcTierId];
    if (bet < tierConfig.minBet || bet > tierConfig.maxBet) {
      res.status(400).json({
        error: `${tierConfig.label} tier: bet must be between ${tierConfig.minBet} and ${tierConfig.maxBet} ${tierConfig.currency.toUpperCase()}.`,
      });
      return;
    }
  } else {
    if (bet < MIN_BET_TC) {
      res.status(400).json({ error: `Minimum bet is ${MIN_BET_TC} TC.` });
      return;
    }
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .for("update")
        .limit(1);

      if (!user) throw new Error("USER_NOT_FOUND");

      // Check for existing active round
      const [activeRound] = await tx
        .select({ id: minesRoundsTable.id })
        .from(minesRoundsTable)
        .where(
          and(
            eq(minesRoundsTable.telegramId, telegramId),
            eq(minesRoundsTable.status, "active"),
          ),
        )
        .limit(1);
      if (activeRound) throw new Error("ACTIVE_ROUND_EXISTS");

      const vip = isVipActive(user);

      if (mode === "gc") {
        const tierConfig = GC_TIERS[tier as GcTierId];

        // ── Check daily GC cap ──
        const today = todayStr();
        const gcEarnedToday = user.dailyGcFromMinesDate === today ? (user.dailyGcFromMines ?? 0) : 0;
        const dailyCap = vip ? DAILY_GC_FROM_MINES_CAP_VIP : DAILY_GC_FROM_MINES_CAP_FREE;
        if (gcEarnedToday >= dailyCap) throw new Error("DAILY_GC_CAP_REACHED");

        // ── Consume a round pass ──
        const [pass] = await tx
          .select()
          .from(minesRoundPassesTable)
          .where(
            and(
              eq(minesRoundPassesTable.telegramId, telegramId),
              eq(minesRoundPassesTable.tier, tier!),
              gt(minesRoundPassesTable.remaining, 0),
            ),
          )
          .limit(1);

        if (!pass) throw new Error("NO_ROUND_PASS");

        await tx
          .update(minesRoundPassesTable)
          .set({ remaining: sql`${minesRoundPassesTable.remaining} - 1` })
          .where(eq(minesRoundPassesTable.id, pass.id));

        // ── Deduct bet (GC for bronze/silver, TC for gold) ──
        if (tierConfig.currency === "gc") {
          if ((user.goldCoins ?? 0) < bet) throw new Error("INSUFFICIENT_GC");
          await tx
            .update(usersTable)
            .set({ goldCoins: sql`${usersTable.goldCoins} - ${bet}` })
            .where(eq(usersTable.telegramId, telegramId));
        } else {
          // Gold tier: TC bet
          if ((user.tradeCredits ?? 0) < bet) throw new Error("INSUFFICIENT_TC");
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${bet}` })
            .where(eq(usersTable.telegramId, telegramId));
        }
      } else {
        // ── Classic TC mode ──
        const maxBet = vip ? MAX_BET_TC_VIP : MAX_BET_TC_FREE;
        if (bet > maxBet) throw new Error(`MAX_BET_${maxBet}`);
        if ((user.tradeCredits ?? 0) < bet) throw new Error("INSUFFICIENT_TC");

        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${bet}` })
          .where(eq(usersTable.telegramId, telegramId));
      }

      // ── Consume gems if requested ──
      const activeGemsState: ActiveGemsState = {};
      const MINES_GEM_TYPES = ["revenge_shield", "safe_reveal", "gem_magnet", "second_chance"];

      if (useGems && useGems.length > 0) {
        const userGems = await tx
          .select()
          .from(gemInventoryTable)
          .where(
            and(
              eq(gemInventoryTable.telegramId, telegramId),
              gt(gemInventoryTable.usesRemaining, 0),
            ),
          );

        const usedTypes = new Set<string>();
        for (const gemId of useGems) {
          const gem = userGems.find((g) => g.id === gemId);
          if (!gem) throw new Error(`GEM_NOT_FOUND_${gemId}`);
          if (gem.usesRemaining <= 0) throw new Error(`GEM_DEPLETED_${gemId}`);
          if (!MINES_GEM_TYPES.includes(gem.gemType)) throw new Error(`GEM_NOT_MINES_TYPE_${gem.gemType}`);
          if (usedTypes.has(gem.gemType)) throw new Error(`GEM_DUPLICATE_TYPE_${gem.gemType}`);
          usedTypes.add(gem.gemType);

          await tx
            .update(gemInventoryTable)
            .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
            .where(eq(gemInventoryTable.id, gemId));

          switch (gem.gemType) {
            case "revenge_shield":
              activeGemsState.revenge_shield = true;
              break;
            case "safe_reveal":
              activeGemsState.safe_reveal_used = false;
              break;
            case "gem_magnet":
              activeGemsState.gem_magnet_left = GEM_MAGNET_TILES;
              break;
            case "second_chance":
              activeGemsState.second_chance = true;
              break;
          }
        }
      }

      const serverSeed = crypto.randomBytes(32).toString("hex");
      const serverSeedHash = crypto.createHash("sha256").update(serverSeed).digest("hex");

      const [round] = await tx
        .insert(minesRoundsTable)
        .values({
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
        })
        .returning();

      // If safe_reveal was activated, compute a safe tile
      let safeTileHint: number | null = null;
      if (activeGemsState.safe_reveal_used === false) {
        const mines = placeMines(serverSeed, clientSeed, gridSize, minesCount);
        const total = gridSize * gridSize;
        const safeTiles: number[] = [];
        for (let i = 0; i < total; i++) {
          if (!mines.includes(i)) safeTiles.push(i);
        }
        safeTileHint = safeTiles[Math.floor(Math.random() * safeTiles.length)];
        activeGemsState.safe_reveal_used = true;
        await tx
          .update(minesRoundsTable)
          .set({ activeGems: JSON.stringify(activeGemsState) })
          .where(eq(minesRoundsTable.id, round.id));
      }

      // Get updated balances
      const [updatedUser] = await tx
        .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins })
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1);

      return {
        round,
        balanceTc: updatedUser?.tradeCredits ?? 0,
        balanceGc: updatedUser?.goldCoins ?? 0,
        activeGemsState,
        safeTileHint,
      };
    });

    logger.info(
      { telegramId, roundId: outcome.round.id, gridSize, minesCount, bet, mode, tier },
      "Mines round started",
    );

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
      balances: {
        tradeCredits: outcome.balanceTc,
        goldCoins: outcome.balanceGc,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "USER_NOT_FOUND") { res.status(404).json({ error: "User not found." }); return; }
    if (msg === "INSUFFICIENT_TC") { res.status(400).json({ error: "Insufficient Trade Credits." }); return; }
    if (msg === "INSUFFICIENT_GC") { res.status(400).json({ error: "Insufficient Gold Coins." }); return; }
    if (msg === "ACTIVE_ROUND_EXISTS") { res.status(409).json({ error: "You already have an active mines round." }); return; }
    if (msg === "NO_ROUND_PASS") { res.status(400).json({ error: "No round pass available. Purchase one to play GC Mines." }); return; }
    if (msg === "DAILY_GC_CAP_REACHED") { res.status(400).json({ error: "Daily GC earnings cap reached. Come back tomorrow!" }); return; }
    if (msg.startsWith("MAX_BET_")) {
      res.status(400).json({ error: `Maximum bet is ${msg.slice(8)} TC.` });
      return;
    }
    if (msg.startsWith("GEM_")) {
      res.status(400).json({ error: "Power-up error. Check your inventory." });
      return;
    }
    logger.error({ err, telegramId }, "Mines start failed");
    res.status(500).json({ error: "Failed to start mines round." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /mines/reveal — works for both TC and GC modes
// ═══════════════════════════════════════════════════════════════════════════
const RevealBody = z.object({
  telegramId: z.string().min(1),
  roundId: z.number().int().positive(),
  tile: z.number().int().min(0),
});

router.post("/mines/reveal", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = RevealBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { roundId, tile } = parsed.data;

  try {
    const outcome = await db.transaction(async (tx) => {
      const [round] = await tx
        .select()
        .from(minesRoundsTable)
        .where(and(eq(minesRoundsTable.id, roundId), eq(minesRoundsTable.telegramId, telegramId)))
        .for("update")
        .limit(1);

      if (!round) throw new Error("ROUND_NOT_FOUND");
      if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

      const gridSize = round.gridSize as GridSize;
      const total = gridSize * gridSize;
      if (tile < 0 || tile >= total) throw new Error("INVALID_TILE");

      const revealed = parseRevealed(round.revealed);
      if (revealed.includes(tile)) throw new Error("TILE_ALREADY_REVEALED");

      const mines = placeMines(round.serverSeed, round.clientSeed, gridSize, round.minesCount);
      const isMine = mines.includes(tile);
      const gemsState = parseActiveGems(round.activeGems);
      const isGcMode = round.mode === "gc";

      if (isMine) {
        // ── Revenge Shield ──
        if (gemsState.revenge_shield) {
          gemsState.revenge_shield = false;
          await tx
            .update(minesRoundsTable)
            .set({ activeGems: JSON.stringify(gemsState) })
            .where(eq(minesRoundsTable.id, roundId));

          return {
            hit: true,
            shielded: true,
            round: { ...round, activeGems: JSON.stringify(gemsState) },
            shieldedTile: tile,
          };
        }

        // ── Second Chance (refund bet) ──
        if (gemsState.second_chance) {
          gemsState.second_chance = false;

          // Refund in the correct currency
          if (isGcMode && round.tier !== "gold") {
            // Bronze/Silver: refund GC
            await tx
              .update(usersTable)
              .set({ goldCoins: sql`${usersTable.goldCoins} + ${round.bet}` })
              .where(eq(usersTable.telegramId, telegramId));
          } else {
            // TC mode or Gold tier: refund TC
            await tx
              .update(usersTable)
              .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${round.bet}` })
              .where(eq(usersTable.telegramId, telegramId));
          }

          await tx
            .update(minesRoundsTable)
            .set({
              status: "bust",
              revealed: JSON.stringify([...revealed, tile]),
              activeGems: JSON.stringify(gemsState),
              payout: round.bet,
            })
            .where(eq(minesRoundsTable.id, roundId));

          const [user] = await tx
            .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins })
            .from(usersTable)
            .where(eq(usersTable.telegramId, telegramId))
            .limit(1);

          return {
            hit: true,
            shielded: false,
            secondChance: true,
            refund: round.bet,
            round: { ...round, status: "bust", revealed: JSON.stringify([...revealed, tile]) },
            mines,
            balanceTc: user?.tradeCredits ?? 0,
            balanceGc: user?.goldCoins ?? 0,
          };
        }

        // ── Normal bust ──
        const [updated] = await tx
          .update(minesRoundsTable)
          .set({ status: "bust", revealed: JSON.stringify([...revealed, tile]) })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();
        return { hit: true, shielded: false, round: updated, mines };
      } else {
        // ── Safe tile ──
        const nextRevealed = [...revealed, tile];
        let nextMultiplier = computeMultiplier(gridSize, round.minesCount, nextRevealed.length);

        if (gemsState.gem_magnet_left && gemsState.gem_magnet_left > 0) {
          nextMultiplier = +(nextMultiplier * GEM_MAGNET_BOOST).toFixed(4);
          gemsState.gem_magnet_left -= 1;
        }

        const [updated] = await tx
          .update(minesRoundsTable)
          .set({
            revealed: JSON.stringify(nextRevealed),
            multiplier: nextMultiplier,
            activeGems: JSON.stringify(gemsState),
          })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();
        return { hit: false, shielded: false, round: updated };
      }
    });

    if (outcome.shielded) {
      res.json({
        hit: true,
        shielded: true,
        shieldedTile: (outcome as any).shieldedTile,
        revealed: parseRevealed(outcome.round.revealed),
        multiplier: outcome.round.multiplier,
        status: "active",
        activeGems: parseActiveGems(typeof outcome.round.activeGems === "string" ? outcome.round.activeGems : "{}"),
      });
      return;
    }

    if ((outcome as any).secondChance) {
      res.json({
        hit: true,
        shielded: false,
        secondChance: true,
        refund: (outcome as any).refund,
        revealed: parseRevealed(outcome.round.revealed),
        multiplier: outcome.round.multiplier,
        status: "bust",
        mines: (outcome as any).mines,
        balances: {
          tradeCredits: (outcome as any).balanceTc,
          goldCoins: (outcome as any).balanceGc,
        },
      });
      return;
    }

    res.json({
      hit: outcome.hit,
      revealed: parseRevealed(outcome.round.revealed),
      multiplier: outcome.round.multiplier,
      status: outcome.round.status,
      mines: outcome.hit ? (outcome as any).mines : undefined,
      activeGems: parseActiveGems(typeof outcome.round.activeGems === "string" ? outcome.round.activeGems : "{}"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") { res.status(404).json({ error: "Round not found." }); return; }
    if (msg === "ROUND_NOT_ACTIVE") { res.status(400).json({ error: "Round is no longer active." }); return; }
    logger.error({ err, telegramId, roundId }, "Mines reveal failed");
    res.status(500).json({ error: "Failed to reveal tile." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /mines/cashout — handles TC payout and GC payout with daily cap
// ═══════════════════════════════════════════════════════════════════════════
const CashoutBody = z.object({
  telegramId: z.string().min(1),
  roundId: z.number().int().positive(),
});

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
    const outcome = await db.transaction(async (tx) => {
      const [round] = await tx
        .select()
        .from(minesRoundsTable)
        .where(and(eq(minesRoundsTable.id, roundId), eq(minesRoundsTable.telegramId, telegramId)))
        .for("update")
        .limit(1);

      if (!round) throw new Error("ROUND_NOT_FOUND");
      if (round.status !== "active") throw new Error("ROUND_NOT_ACTIVE");

      const revealed = parseRevealed(round.revealed);
      if (revealed.length === 0) throw new Error("NO_TILES_REVEALED");

      const isGcMode = round.mode === "gc";
      const tierConfig = round.tier ? GC_TIERS[round.tier as GcTierId] : null;

      if (isGcMode && tierConfig) {
        // ── GC Mines cashout ──
        const [user] = await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .for("update")
          .limit(1);

        if (!user) throw new Error("USER_NOT_FOUND");

        const vip = isVipActive(user);
        const dailyCap = vip ? DAILY_GC_FROM_MINES_CAP_VIP : DAILY_GC_FROM_MINES_CAP_FREE;
        const today = todayStr();
        const gcEarnedToday = user.dailyGcFromMinesDate === today ? (user.dailyGcFromMines ?? 0) : 0;
        const gcRemaining = Math.max(0, dailyCap - gcEarnedToday);

        let rawPayout: number;
        if (round.tier === "gold") {
          // Gold tier: TC bet → GC win (conversion ratio applied)
          rawPayout = Math.floor(round.bet * round.multiplier * GOLD_TC_TO_GC_RATIO);
        } else {
          // Bronze/Silver: GC bet → GC win
          rawPayout = Math.floor(round.bet * round.multiplier);
        }

        // Apply max payout cap per round
        rawPayout = Math.min(rawPayout, tierConfig.maxPayoutGc);

        // Apply daily GC cap
        const gcPayout = Math.min(rawPayout, gcRemaining);

        // Credit GC to user
        if (gcPayout > 0) {
          await tx
            .update(usersTable)
            .set({
              goldCoins: sql`${usersTable.goldCoins} + ${gcPayout}`,
              totalGcEarned: sql`${usersTable.totalGcEarned} + ${gcPayout}`,
              dailyGcFromMines: gcEarnedToday + gcPayout,
              dailyGcFromMinesDate: today,
            })
            .where(eq(usersTable.telegramId, telegramId));
        }

        // For Gold tier, also return the TC payout (bet × multiplier)
        let tcPayout = 0;
        if (round.tier === "gold") {
          tcPayout = Math.floor(round.bet * round.multiplier);
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${tcPayout}` })
            .where(eq(usersTable.telegramId, telegramId));
        }

        const [updated] = await tx
          .update(minesRoundsTable)
          .set({ status: "won", payout: gcPayout })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();

        const [finalUser] = await tx
          .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins })
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .limit(1);

        const mines = placeMines(
          round.serverSeed,
          round.clientSeed,
          round.gridSize as GridSize,
          round.minesCount,
        );

        return {
          round: updated,
          gcPayout,
          tcPayout,
          dailyGcFromMines: gcEarnedToday + gcPayout,
          dailyGcCap: dailyCap,
          balanceTc: finalUser?.tradeCredits ?? 0,
          balanceGc: finalUser?.goldCoins ?? 0,
          mines,
        };
      } else {
        // ── Classic TC cashout ──
        const payout = Math.floor(round.bet * round.multiplier);

        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${payout}` })
          .where(eq(usersTable.telegramId, telegramId));

        const [updated] = await tx
          .update(minesRoundsTable)
          .set({ status: "won", payout })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();

        const [user] = await tx
          .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins })
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .limit(1);

        const mines = placeMines(
          round.serverSeed,
          round.clientSeed,
          round.gridSize as GridSize,
          round.minesCount,
        );

        return {
          round: updated,
          gcPayout: 0,
          tcPayout: payout,
          balanceTc: user?.tradeCredits ?? 0,
          balanceGc: user?.goldCoins ?? 0,
          mines,
        };
      }
    });

    res.json({
      status: "won",
      mode: outcome.round.mode,
      tier: outcome.round.tier,
      payout: outcome.round.payout,
      gcPayout: outcome.gcPayout,
      tcPayout: outcome.tcPayout ?? 0,
      dailyGcFromMines: (outcome as any).dailyGcFromMines,
      dailyGcCap: (outcome as any).dailyGcCap,
      balances: {
        tradeCredits: outcome.balanceTc,
        goldCoins: outcome.balanceGc,
      },
      mines: outcome.mines,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") { res.status(404).json({ error: "Round not found." }); return; }
    if (msg === "ROUND_NOT_ACTIVE") { res.status(400).json({ error: "Round is no longer active." }); return; }
    if (msg === "NO_TILES_REVEALED") { res.status(400).json({ error: "Reveal at least one safe tile first." }); return; }
    logger.error({ err, telegramId, roundId }, "Mines cashout failed");
    res.status(500).json({ error: "Failed to cash out." });
  }
});

export default router;

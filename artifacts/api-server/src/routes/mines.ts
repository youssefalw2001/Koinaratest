import crypto from "crypto";
import { Router, type IRouter } from "express";
import { eq, desc, and, gt, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, minesRoundsTable, gemInventoryTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const minesRateLimiter = createRouteRateLimiter("mines-action", {
  limit: 40,
  windowMs: 10_000,
  message: "Too many mines actions. Slow down and try again.",
});

// ---------- Game config ----------
const HOUSE_EDGE_MULT = 0.965; // 3.5% house edge
const MIN_BET_TC = 50;
const MAX_BET_TC_FREE = 2_000;
const MAX_BET_TC_VIP = 8_000;
const GEM_MAGNET_BOOST = 1.25; // 25% boost per tile (not 50% — keeps house edge healthy)
const GEM_MAGNET_TILES = 3;

const ALLOWED_GRID_SIZES = [3, 4, 5] as const;
type GridSize = (typeof ALLOWED_GRID_SIZES)[number];

// ---------- Active gems state stored per round ----------
interface ActiveGemsState {
  revenge_shield?: boolean;   // absorbs 1 mine hit, then removed
  safe_reveal_used?: boolean; // already used this round
  gem_magnet_left?: number;   // tiles remaining with boost
  second_chance?: boolean;    // refund bet on bust
}

function parseActiveGems(raw: string | null | undefined): ActiveGemsState {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ActiveGemsState;
  } catch {
    return {};
  }
}

// ---------- Helpers ----------
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

function isVipForBetCap(user: {
  isVip: boolean;
  vipExpiresAt: Date | null;
  vipTrialExpiresAt: Date | null;
}): boolean {
  const now = new Date();
  if (user.isVip && user.vipExpiresAt && user.vipExpiresAt > now) return true;
  if (user.vipTrialExpiresAt && user.vipTrialExpiresAt > now) return true;
  return false;
}

// ========== GET /mines/config ==========
router.get("/mines/config", (_req, res): void => {
  res.json({
    gridSizes: ALLOWED_GRID_SIZES,
    houseEdge: 1 - HOUSE_EDGE_MULT,
    minBet: MIN_BET_TC,
    maxBetFree: MAX_BET_TC_FREE,
    maxBetVip: MAX_BET_TC_VIP,
    mines: Object.fromEntries(ALLOWED_GRID_SIZES.map((g) => [g, minesBounds(g)])),
  });
});

// ========== GET /mines/active/:telegramId ==========
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
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      revealed: parseRevealed(round.revealed),
      multiplier: round.multiplier,
      activeGems: parseActiveGems(round.activeGems),
      createdAt: round.createdAt.toISOString(),
    },
  });
});

// ========== POST /mines/start ==========
const StartBody = z.object({
  telegramId: z.string().min(1),
  gridSize: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  minesCount: z.number().int().min(1),
  bet: z.number().int().min(MIN_BET_TC),
  clientSeed: z.string().min(1).max(128),
  // Optional: gem IDs to activate for this round (consumed on start)
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
  const { gridSize, minesCount, bet, clientSeed, useGems } = parsed.data;

  const bounds = minesBounds(gridSize);
  if (minesCount < bounds.min || minesCount > bounds.max) {
    res.status(400).json({
      error: `mines must be between ${bounds.min} and ${bounds.max} for a ${gridSize}×${gridSize} grid.`,
    });
    return;
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

      const maxBet = isVipForBetCap(user) ? MAX_BET_TC_VIP : MAX_BET_TC_FREE;
      if (bet > maxBet) throw new Error(`MAX_BET_${maxBet}`);
      if ((user.tradeCredits ?? 0) < bet) throw new Error("INSUFFICIENT_TC");

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

      // ── Consume gems if requested ──
      const activeGemsState: ActiveGemsState = {};
      const MINES_GEM_TYPES = ["revenge_shield", "safe_reveal", "gem_magnet", "second_chance"];

      if (useGems && useGems.length > 0) {
        // Fetch the requested gems
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
          const gem = userGems.find(g => g.id === gemId);
          if (!gem) throw new Error(`GEM_NOT_FOUND_${gemId}`);
          if (gem.usesRemaining <= 0) throw new Error(`GEM_DEPLETED_${gemId}`);
          if (!MINES_GEM_TYPES.includes(gem.gemType)) throw new Error(`GEM_NOT_MINES_TYPE_${gem.gemType}`);
          if (usedTypes.has(gem.gemType)) throw new Error(`GEM_DUPLICATE_TYPE_${gem.gemType}`);
          usedTypes.add(gem.gemType);

          // Decrement uses
          await tx
            .update(gemInventoryTable)
            .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
            .where(eq(gemInventoryTable.id, gemId));

          // Set active state
          switch (gem.gemType) {
            case "revenge_shield":
              activeGemsState.revenge_shield = true;
              break;
            case "safe_reveal":
              activeGemsState.safe_reveal_used = false; // will be used when requested
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

      // Deduct bet
      await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${bet}` })
        .where(eq(usersTable.telegramId, telegramId));

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
        })
        .returning();

      // If safe_reveal was activated, compute a safe tile to return
      let safeTileHint: number | null = null;
      if (activeGemsState.safe_reveal_used === false) {
        const mines = placeMines(serverSeed, clientSeed, gridSize, minesCount);
        const total = gridSize * gridSize;
        const safeTiles: number[] = [];
        for (let i = 0; i < total; i++) {
          if (!mines.includes(i)) safeTiles.push(i);
        }
        // Pick a random safe tile
        safeTileHint = safeTiles[Math.floor(Math.random() * safeTiles.length)];
        // Mark as used
        activeGemsState.safe_reveal_used = true;
        await tx
          .update(minesRoundsTable)
          .set({ activeGems: JSON.stringify(activeGemsState) })
          .where(eq(minesRoundsTable.id, round.id));
      }

      return { round, balanceTc: (user.tradeCredits ?? 0) - bet, activeGemsState, safeTileHint };
    });

    logger.info(
      { telegramId, roundId: outcome.round.id, gridSize, minesCount, bet, gems: outcome.activeGemsState },
      "Mines round started",
    );

    res.status(201).json({
      roundId: outcome.round.id,
      gridSize,
      minesCount,
      bet,
      serverSeedHash: outcome.round.serverSeedHash,
      clientSeed,
      revealed: [],
      multiplier: 1,
      activeGems: outcome.activeGemsState,
      safeTileHint: outcome.safeTileHint,
      balances: { tradeCredits: outcome.balanceTc },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "USER_NOT_FOUND") {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (msg === "INSUFFICIENT_TC") {
      res.status(400).json({ error: "Insufficient Trade Credits." });
      return;
    }
    if (msg.startsWith("MAX_BET_")) {
      const cap = msg.slice("MAX_BET_".length);
      res.status(400).json({ error: `Maximum bet is ${cap} Trade Credits.` });
      return;
    }
    if (msg === "ACTIVE_ROUND_EXISTS") {
      res.status(409).json({ error: "You already have an active mines round. Finish it first." });
      return;
    }
    if (msg.startsWith("GEM_NOT_FOUND")) {
      res.status(400).json({ error: "One or more selected power-ups not found in your inventory." });
      return;
    }
    if (msg.startsWith("GEM_DEPLETED")) {
      res.status(400).json({ error: "One or more selected power-ups has no uses remaining." });
      return;
    }
    if (msg.startsWith("GEM_NOT_MINES_TYPE")) {
      res.status(400).json({ error: "Only Mines power-ups can be used in Mines." });
      return;
    }
    if (msg.startsWith("GEM_DUPLICATE_TYPE")) {
      res.status(400).json({ error: "Cannot use two of the same power-up type in one round." });
      return;
    }
    logger.error({ err, telegramId }, "Mines start failed");
    res.status(500).json({ error: "Failed to start mines round." });
  }
});

// ========== POST /mines/reveal ==========
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

      if (isMine) {
        // ── Check Revenge Shield ──
        if (gemsState.revenge_shield) {
          // Shield absorbs the hit — remove shield, keep round active
          gemsState.revenge_shield = false;
          // Don't add this tile to revealed (it was a mine, user "dodged" it)
          // But we need to let the user know which tile was shielded
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

        // ── Check Second Chance ──
        if (gemsState.second_chance) {
          gemsState.second_chance = false;
          // Refund the bet
          await tx
            .update(usersTable)
            .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${round.bet}` })
            .where(eq(usersTable.telegramId, telegramId));

          // End the round as bust but with refund
          await tx
            .update(minesRoundsTable)
            .set({
              status: "bust",
              revealed: JSON.stringify([...revealed, tile]),
              activeGems: JSON.stringify(gemsState),
              payout: round.bet, // refunded amount
            })
            .where(eq(minesRoundsTable.id, roundId));

          const [user] = await tx
            .select({ tradeCredits: usersTable.tradeCredits })
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

        // Apply Gem Magnet boost if active
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
      // Shield absorbed the mine — round continues
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
      // Second chance — bust but refunded
      res.json({
        hit: true,
        shielded: false,
        secondChance: true,
        refund: (outcome as any).refund,
        revealed: parseRevealed(outcome.round.revealed),
        multiplier: outcome.round.multiplier,
        status: "bust",
        mines: (outcome as any).mines,
        balances: { tradeCredits: (outcome as any).balanceTc },
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
    if (msg === "ROUND_NOT_FOUND") {
      res.status(404).json({ error: "Round not found." });
      return;
    }
    if (msg === "ROUND_NOT_ACTIVE") {
      res.status(400).json({ error: "Round is no longer active." });
      return;
    }
    logger.error({ err, telegramId, roundId }, "Mines reveal failed");
    res.status(500).json({ error: "Failed to reveal tile." });
  }
});

// ========== POST /mines/cashout ==========
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
        .select({ tradeCredits: usersTable.tradeCredits })
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1);

      const mines = placeMines(
        round.serverSeed,
        round.clientSeed,
        round.gridSize as GridSize,
        round.minesCount,
      );

      return { round: updated, balanceTc: user?.tradeCredits ?? 0, mines };
    });

    res.json({
      status: "won",
      payout: outcome.round.payout,
      balances: { tradeCredits: outcome.balanceTc },
      mines: outcome.mines,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") {
      res.status(404).json({ error: "Round not found." });
      return;
    }
    if (msg === "ROUND_NOT_ACTIVE") {
      res.status(400).json({ error: "Round is no longer active." });
      return;
    }
    if (msg === "NO_TILES_REVEALED") {
      res.status(400).json({ error: "Reveal at least one safe tile before cashing out." });
      return;
    }
    logger.error({ err, telegramId, roundId }, "Mines cashout failed");
    res.status(500).json({ error: "Failed to cash out." });
  }
});

export default router;

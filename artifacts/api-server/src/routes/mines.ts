import crypto from "crypto";
import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, minesRoundsTable } from "@workspace/db";
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
// 1% house edge, applied to the fair multiplier.
const HOUSE_EDGE_MULT = 0.99;
const MIN_BET_TC = 50;
const MAX_BET_TC_FREE = 2_000;
const MAX_BET_TC_VIP = 10_000;

const ALLOWED_GRID_SIZES = [3, 4, 5] as const;
type GridSize = (typeof ALLOWED_GRID_SIZES)[number];

// Mines bounds per grid: min 1, leave at least 1 safe tile above the first
// reveal so the game has tension but isn't an auto-loss.
function minesBounds(gridSize: GridSize): { min: number; max: number } {
  const total = gridSize * gridSize;
  return { min: 1, max: total - 2 };
}

// ---------- Provably-fair RNG ----------
// Fisher-Yates shuffle seeded with HMAC(serverSeed, clientSeed || counter).
// Consumes 4 bytes per draw; refreshes the HMAC output in 32-byte chunks so
// large grids still have plenty of entropy.
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

// ---------- Multiplier math ----------
// Fair multiplier after k safe reveals on an N×N grid with M mines:
//   product_{i=0..k-1} (total-i) / (safeTiles-i)
// Apply the 1% house edge once at the end.
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

// ---------- GET /mines/config ----------

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

// ---------- GET /mines/active/:telegramId ----------

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
      createdAt: round.createdAt.toISOString(),
    },
  });
});

// ---------- POST /mines/start ----------

const StartBody = z.object({
  telegramId: z.string().min(1),
  gridSize: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  minesCount: z.number().int().min(1),
  bet: z.number().int().min(MIN_BET_TC),
  clientSeed: z.string().min(1).max(128),
});

router.post("/mines/start", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { gridSize, minesCount, bet, clientSeed } = parsed.data;

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

      // Refuse to start a new round while one is still open — keeps the UI
      // and the idempotency logic simple.
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

      // Debit the stake up-front.
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
        })
        .returning();

      return { round, balanceTc: (user.tradeCredits ?? 0) - bet };
    });

    logger.info(
      { telegramId, roundId: outcome.round.id, gridSize, minesCount, bet },
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
    logger.error({ err, telegramId }, "Mines start failed");
    res.status(500).json({ error: "Failed to start mines round." });
  }
});

// ---------- POST /mines/reveal ----------

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
      if (tile < 0 || tile >= total) throw new Error("TILE_OUT_OF_RANGE");

      const revealed = parseRevealed(round.revealed);
      if (revealed.includes(tile)) throw new Error("TILE_ALREADY_REVEALED");

      const mines = placeMines(round.serverSeed, round.clientSeed, gridSize, round.minesCount);
      const isMine = mines.includes(tile);

      if (isMine) {
        await tx
          .update(minesRoundsTable)
          .set({
            status: "busted",
            multiplier: 0,
            payout: 0,
            revealed: JSON.stringify([...revealed, tile]),
            completedAt: new Date(),
          })
          .where(eq(minesRoundsTable.id, roundId));

        return {
          isMine: true,
          tile,
          revealed: [...revealed, tile],
          multiplier: 0,
          status: "busted" as const,
          mines,
          serverSeed: round.serverSeed,
        };
      }

      const nextRevealed = [...revealed, tile];
      const nextMultiplier = computeMultiplier(gridSize, round.minesCount, nextRevealed.length);
      const safeRemaining = total - round.minesCount - nextRevealed.length;

      await tx
        .update(minesRoundsTable)
        .set({
          revealed: JSON.stringify(nextRevealed),
          multiplier: nextMultiplier,
        })
        .where(eq(minesRoundsTable.id, roundId));

      // Auto cash-out when there are no safe tiles left.
      if (safeRemaining === 0) {
        const payout = Math.floor(round.bet * nextMultiplier);
        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${payout}` })
          .where(eq(usersTable.telegramId, telegramId));
        await tx
          .update(minesRoundsTable)
          .set({
            status: "cashed_out",
            payout,
            completedAt: new Date(),
          })
          .where(eq(minesRoundsTable.id, roundId));

        return {
          isMine: false,
          tile,
          revealed: nextRevealed,
          multiplier: nextMultiplier,
          status: "cashed_out" as const,
          payout,
          mines,
          serverSeed: round.serverSeed,
        };
      }

      return {
        isMine: false,
        tile,
        revealed: nextRevealed,
        multiplier: nextMultiplier,
        status: "active" as const,
      };
    });

    res.json(outcome);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") {
      res.status(404).json({ error: "Round not found." });
      return;
    }
    if (msg === "ROUND_NOT_ACTIVE") {
      res.status(400).json({ error: "Round already finished." });
      return;
    }
    if (msg === "TILE_OUT_OF_RANGE") {
      res.status(400).json({ error: "Invalid tile index." });
      return;
    }
    if (msg === "TILE_ALREADY_REVEALED") {
      res.status(400).json({ error: "Tile already revealed." });
      return;
    }
    logger.error({ err, telegramId, roundId, tile }, "Mines reveal failed");
    res.status(500).json({ error: "Failed to reveal tile." });
  }
});

// ---------- POST /mines/cashout ----------

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

      const multiplier = computeMultiplier(
        round.gridSize as GridSize,
        round.minesCount,
        revealed.length,
      );
      const payout = Math.floor(round.bet * multiplier);
      const mines = placeMines(
        round.serverSeed,
        round.clientSeed,
        round.gridSize as GridSize,
        round.minesCount,
      );

      await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${payout}` })
        .where(eq(usersTable.telegramId, telegramId));

      await tx
        .update(minesRoundsTable)
        .set({
          status: "cashed_out",
          multiplier,
          payout,
          completedAt: new Date(),
        })
        .where(eq(minesRoundsTable.id, roundId));

      const [updated] = await tx
        .select({ tradeCredits: usersTable.tradeCredits })
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1);

      return {
        status: "cashed_out" as const,
        revealed,
        multiplier,
        payout,
        mines,
        serverSeed: round.serverSeed,
        balanceTc: updated?.tradeCredits ?? 0,
      };
    });

    logger.info(
      { telegramId, roundId, multiplier: outcome.multiplier, payout: outcome.payout },
      "Mines cashed out",
    );

    res.json({
      status: outcome.status,
      revealed: outcome.revealed,
      multiplier: outcome.multiplier,
      payout: outcome.payout,
      mines: outcome.mines,
      serverSeed: outcome.serverSeed,
      balances: { tradeCredits: outcome.balanceTc },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "ROUND_NOT_FOUND") {
      res.status(404).json({ error: "Round not found." });
      return;
    }
    if (msg === "ROUND_NOT_ACTIVE") {
      res.status(400).json({ error: "Round already finished." });
      return;
    }
    if (msg === "NO_TILES_REVEALED") {
      res.status(400).json({ error: "Reveal at least one tile before cashing out." });
      return;
    }
    logger.error({ err, telegramId, roundId }, "Mines cashout failed");
    res.status(500).json({ error: "Failed to cash out." });
  }
});

// ---------- GET /mines/history/:telegramId ----------

router.get("/mines/history/:telegramId", async (req, res): Promise<void> => {
  const requested = String(req.params.telegramId ?? "").trim();
  if (!requested) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, requested);
  if (!telegramId) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 50);

  const rows = await db
    .select()
    .from(minesRoundsTable)
    .where(eq(minesRoundsTable.telegramId, telegramId))
    .orderBy(desc(minesRoundsTable.createdAt))
    .limit(limit);

  res.json({
    history: rows.map((r) => ({
      roundId: r.id,
      gridSize: r.gridSize,
      minesCount: r.minesCount,
      bet: r.bet,
      status: r.status,
      multiplier: r.multiplier,
      payout: r.payout,
      revealed: parseRevealed(r.revealed),
      serverSeedHash: r.serverSeedHash,
      serverSeed: r.status === "active" ? null : r.serverSeed,
      clientSeed: r.clientSeed,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  });
});

export default router;

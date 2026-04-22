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
const HOUSE_EDGE_MULT = 0.965; // 3.5% house edge
const MIN_BET_TC = 50;
const MAX_BET_TC_FREE = 2_000;
const MAX_BET_TC_VIP = 8_000; // Updated to 8,000 as requested

const ALLOWED_GRID_SIZES = [3, 4, 5] as const;
type GridSize = (typeof ALLOWED_GRID_SIZES)[number];

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

      if (isMine) {
        const [updated] = await tx
          .update(minesRoundsTable)
          .set({ status: "bust", revealed: JSON.stringify([...revealed, tile]) })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();
        return { hit: true, round: updated, mines };
      } else {
        const nextRevealed = [...revealed, tile];
        const nextMultiplier = computeMultiplier(gridSize, round.minesCount, nextRevealed.length);
        const [updated] = await tx
          .update(minesRoundsTable)
          .set({ revealed: JSON.stringify(nextRevealed), multiplier: nextMultiplier })
          .where(eq(minesRoundsTable.id, roundId))
          .returning();
        return { hit: false, round: updated };
      }
    });

    res.json({
      hit: outcome.hit,
      revealed: parseRevealed(outcome.round.revealed),
      multiplier: outcome.round.multiplier,
      status: outcome.round.status,
      mines: outcome.hit ? outcome.mines : undefined,
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

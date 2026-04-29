import crypto from "crypto";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, gemInventoryTable, minesRoundsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";

const router: IRouter = Router();
const SAFE_REVEAL_MIN_REVEALED = 3;
const SAFE_REVEAL_MAX_MINES = 10;

const safeRevealLimiter = createRouteRateLimiter("mines-safe-reveal", {
  limit: 12,
  windowMs: 10_000,
  message: "Too many Safe Reveal attempts. Slow down and try again.",
});

type ActiveGemsState = {
  revenge_shield?: boolean;
  safe_reveal_used?: boolean;
  gem_magnet_left?: number;
  second_chance?: boolean;
};

function parseJsonArray(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function parseActiveGems(raw: string | null | undefined): ActiveGemsState {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ActiveGemsState;
  } catch {
    return {};
  }
}

function placeMines(serverSeed: string, clientSeed: string, gridSize: number, minesCount: number): number[] {
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

function computeMultiplier(gridSize: number, minesCount: number, safeRevealed: number): number {
  const total = gridSize * gridSize;
  const safeTiles = total - minesCount;
  if (safeRevealed <= 0) return 1;
  if (safeRevealed > safeTiles) return 0;
  let mult = 1;
  for (let i = 0; i < safeRevealed; i++) {
    mult *= (total - i) / (safeTiles - i);
  }
  return +(0.945 * mult).toFixed(4);
}

// Safe Reveal is no longer allowed as a pre-start boost. It must be activated
// after the player has already revealed 3 safe tiles in the current round.
router.post("/mines/start", async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const useGems = Array.isArray(req.body?.useGems) ? req.body.useGems : [];
  if (useGems.length === 0) {
    next();
    return;
  }

  const requested = String(req.body?.telegramId ?? "").trim();
  const telegramId = resolveAuthenticatedTelegramId(req, res, requested);
  if (!telegramId) return;

  const gems = await db
    .select({ id: gemInventoryTable.id, gemType: gemInventoryTable.gemType })
    .from(gemInventoryTable)
    .where(and(eq(gemInventoryTable.telegramId, telegramId), gt(gemInventoryTable.usesRemaining, 0)));

  const selectedSafeReveal = gems.some((gem) => gem.gemType === "safe_reveal" && useGems.includes(gem.id));
  if (!selectedSafeReveal) {
    next();
    return;
  }

  res.status(400).json({
    error: "Safe Reveal unlocks only after 3 safe tiles. Start the round without it, then activate it mid-round.",
    code: "SAFE_REVEAL_UNLOCKS_AFTER_3",
  });
});

router.post("/mines/safe-reveal", safeRevealLimiter, async (req, res): Promise<void> => {
  const telegramIdInput = String(req.body?.telegramId ?? "").trim();
  const roundId = Number(req.body?.roundId);
  if (!telegramIdInput || !Number.isInteger(roundId)) {
    res.status(400).json({ error: "telegramId and roundId are required." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, telegramIdInput);
  if (!telegramId) return;

  try {
    const result = await db.transaction(async (tx) => {
      const [round] = await tx
        .select()
        .from(minesRoundsTable)
        .where(and(eq(minesRoundsTable.id, roundId), eq(minesRoundsTable.telegramId, telegramId), eq(minesRoundsTable.status, "active")))
        .for("update")
        .limit(1);

      if (!round) throw new Error("ROUND_NOT_FOUND");
      const revealed = parseJsonArray(round.revealed);
      const activeGems = parseActiveGems(round.activeGems);

      if (revealed.length < SAFE_REVEAL_MIN_REVEALED) throw new Error("SAFE_REVEAL_LOCKED");
      if (round.tier === "gold") throw new Error("SAFE_REVEAL_DISABLED_GOLD");
      if ((round.minesCount ?? 0) > SAFE_REVEAL_MAX_MINES) throw new Error("SAFE_REVEAL_HIGH_RISK");
      if (activeGems.safe_reveal_used === true) throw new Error("SAFE_REVEAL_ALREADY_USED");

      const [gem] = await tx
        .select()
        .from(gemInventoryTable)
        .where(and(eq(gemInventoryTable.telegramId, telegramId), eq(gemInventoryTable.gemType, "safe_reveal"), gt(gemInventoryTable.usesRemaining, 0)))
        .for("update")
        .limit(1);

      if (!gem) throw new Error("NO_SAFE_REVEAL_GEM");

      const mines = placeMines(round.serverSeed, round.clientSeed, round.gridSize, round.minesCount);
      const revealedSet = new Set(revealed);
      const mineSet = new Set(mines);
      const safeChoices: number[] = [];
      const total = round.gridSize * round.gridSize;
      for (let tile = 0; tile < total; tile++) {
        if (!mineSet.has(tile) && !revealedSet.has(tile)) safeChoices.push(tile);
      }
      if (safeChoices.length === 0) throw new Error("NO_SAFE_TILE_AVAILABLE");

      const digest = crypto.createHash("sha256").update(`${round.serverSeed}:${round.clientSeed}:safe-reveal:${revealed.length}`).digest();
      const pick = digest.readUInt32BE(0) % safeChoices.length;
      const safeTile = safeChoices[pick];
      const nextRevealed = [...revealed, safeTile].sort((a, b) => a - b);
      const multiplier = computeMultiplier(round.gridSize, round.minesCount, nextRevealed.length);
      const nextActiveGems = { ...activeGems, safe_reveal_used: true };

      await tx
        .update(gemInventoryTable)
        .set({ usesRemaining: sql`${gemInventoryTable.usesRemaining} - 1` })
        .where(eq(gemInventoryTable.id, gem.id));

      await tx
        .update(minesRoundsTable)
        .set({
          revealed: JSON.stringify(nextRevealed),
          multiplier,
          activeGems: JSON.stringify(nextActiveGems),
        })
        .where(eq(minesRoundsTable.id, round.id));

      return { safeTile, revealed: nextRevealed, multiplier, activeGems: nextActiveGems };
    });

    res.json({
      ok: true,
      message: "Safe Reveal activated. One safe tile was revealed and the boost was consumed.",
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    const errors: Record<string, string> = {
      ROUND_NOT_FOUND: "No active Mines round found.",
      SAFE_REVEAL_LOCKED: "Safe Reveal unlocks after 3 safe tiles.",
      SAFE_REVEAL_DISABLED_GOLD: "Safe Reveal is disabled on Gold mode.",
      SAFE_REVEAL_HIGH_RISK: "Safe Reveal is unavailable on boards with more than 10 bombs.",
      SAFE_REVEAL_ALREADY_USED: "Safe Reveal can only be used once per round.",
      NO_SAFE_REVEAL_GEM: "You do not have a Safe Reveal power-up available.",
      NO_SAFE_TILE_AVAILABLE: "No safe tile is available.",
    };
    res.status(400).json({ error: errors[msg] ?? "Safe Reveal failed. Please try again.", code: msg });
  }
});

export default router;

import { Router, type IRouter } from "express";
import { eq, and, gt, or, isNull } from "drizzle-orm";
import { db, gemInventoryTable, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { serializeRows } from "../lib/serialize";
import { z } from "zod/v4";
import { isVipActive } from "../lib/vip";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const GEM_CATALOG = {
  // ── Legacy Binary Power-ups (kept for existing inventories only) ─────────
  starter_boost:    { gcCost: 1500, tonCost: 0, usesRemaining: 3, vipOnly: false, category: "legacy" },
  big_swing:        { gcCost: 4000, tonCost: 0, usesRemaining: 2, vipOnly: false, category: "legacy" },
  streak_saver:     { gcCost: 2500, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "legacy" },
  mystery_box:      { gcCost: 1000, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "legacy" },
  daily_refill:     { gcCost: 3000, tonCost: 0, usesRemaining: 1, vipOnly: true,  category: "legacy" },
  double_or_nothing:{ gcCost: 0,    tonCost: 0, usesRemaining: 1, vipOnly: false, category: "legacy" },
  hot_streak:       { gcCost: 2000, tonCost: 0, usesRemaining: 5, vipOnly: false, category: "legacy" },
  double_down:      { gcCost: 1200, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "legacy" },
  precision_lock:   { gcCost: 3500, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "legacy" },
  comeback_king:    { gcCost: 4500, tonCost: 0, usesRemaining: 1, vipOnly: true,  category: "legacy" },

  // ── Safe Battle in-game power-ups (paid with GC) ─────────────────────────
  battle_shield:        { gcCost: 800,  tonCost: 0, usesRemaining: 1, vipOnly: false, category: "battle", expiresHours: null },
  battle_pass:          { gcCost: 3000, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "battle", expiresHours: 24 * 7 },
  battle_streak_saver:  { gcCost: 1200, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "battle", expiresHours: null },
  battle_priority_queue:{ gcCost: 1000, tonCost: 0, usesRemaining: 1, vipOnly: false, category: "battle", expiresHours: 24 },

  // ── Mines Power-ups (paid with TON) ──────────────────────────────────────
  // tonCost is in nanotons (1 TON = 1_000_000_000 nanotons)
  revenge_shield:   { gcCost: 0, tonCost: 200000000, usesRemaining: 1, vipOnly: false, category: "mines" }, // 0.2 TON
  safe_reveal:      { gcCost: 0, tonCost: 100000000, usesRemaining: 1, vipOnly: false, category: "mines" }, // 0.1 TON
  gem_magnet:       { gcCost: 0, tonCost: 150000000, usesRemaining: 3, vipOnly: false, category: "mines" }, // 0.15 TON
  second_chance:    { gcCost: 0, tonCost: 250000000, usesRemaining: 1, vipOnly: false, category: "mines" }, // 0.25 TON
} as const;

type GemType = keyof typeof GEM_CATALOG;

const ALL_GEM_TYPES = [
  "starter_boost",
  "big_swing",
  "streak_saver",
  "mystery_box",
  "daily_refill",
  "double_or_nothing",
  "hot_streak",
  "double_down",
  "precision_lock",
  "comeback_king",
  "battle_shield",
  "battle_pass",
  "battle_streak_saver",
  "battle_priority_queue",
  "revenge_shield",
  "safe_reveal",
  "gem_magnet",
  "second_chance",
] as const;

const PurchaseGemBody = z.object({
  telegramId: z.string(),
  gemType: z.enum(ALL_GEM_TYPES),
});

function expiryFromCatalog(catalog: (typeof GEM_CATALOG)[GemType]): Date | null {
  const hours = "expiresHours" in catalog ? catalog.expiresHours : null;
  return typeof hours === "number" && hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
}

router.post("/gems/purchase", async (req, res): Promise<void> => {
  const parsed = PurchaseGemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { telegramId, gemType } = parsed.data;

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const catalog = GEM_CATALOG[gemType as GemType];

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (catalog.vipOnly && !isVipActive(user)) {
    res.status(403).json({ error: "This item requires VIP" });
    return;
  }

  // Mines power-ups require TON payment — frontend handles TON payment flow
  // and calls this endpoint after confirming the on-chain transaction.
  // For now we trust the frontend (TON verification can be added later like VIP flow).
  if (catalog.category === "mines" && catalog.tonCost > 0) {
    await db.insert(gemInventoryTable).values({
      telegramId: authedId,
      gemType,
      usesRemaining: catalog.usesRemaining,
      expiresAt: expiryFromCatalog(catalog),
    });

    const [updatedUser] = await db
      .select({ goldCoins: usersTable.goldCoins, tradeCredits: usersTable.tradeCredits })
      .from(usersTable)
      .where(eq(usersTable.telegramId, authedId))
      .limit(1);

    res.status(201).json({
      success: true,
      gemType,
      gcSpent: 0,
      tonSpent: catalog.tonCost,
      newGcBalance: updatedUser?.goldCoins ?? user.goldCoins,
      newTcBalance: updatedUser?.tradeCredits ?? user.tradeCredits,
      mysteryReward: null,
    });
    return;
  }

  if (catalog.gcCost > 0 && user.goldCoins < catalog.gcCost) {
    res.status(400).json({ error: "Insufficient Gold Coins" });
    return;
  }

  let mysteryReward: { type: string; amount?: number; gem?: string } | undefined;

  if (catalog.gcCost > 0) {
    const updated = await db
      .update(usersTable)
      .set({ goldCoins: sql`${usersTable.goldCoins} - ${catalog.gcCost}` })
      .where(
        and(
          eq(usersTable.telegramId, authedId),
          gt(usersTable.goldCoins, catalog.gcCost - 1),
        ),
      )
      .returning({ goldCoins: usersTable.goldCoins });

    if (!updated.length) {
      res.status(400).json({ error: "Insufficient Gold Coins" });
      return;
    }
  }

  if (gemType === "mystery_box") {
    const roll = Math.random();
    if (roll < 0.6) {
      const amount = Math.floor(50 + Math.random() * 451);
      await db
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${amount}` })
        .where(eq(usersTable.telegramId, authedId));
      mysteryReward = { type: "tc", amount };
    } else {
      const bonusGems: GemType[] = ["starter_boost", "streak_saver"];
      const bonusGem = bonusGems[Math.floor(Math.random() * bonusGems.length)];
      const bonusCatalog = GEM_CATALOG[bonusGem];
      await db.insert(gemInventoryTable).values({
        telegramId: authedId,
        gemType: bonusGem,
        usesRemaining: bonusCatalog.usesRemaining,
        expiresAt: expiryFromCatalog(bonusCatalog),
      });
      mysteryReward = { type: "gem", gem: bonusGem };
    }
  } else if (gemType === "daily_refill") {
    const vip = isVipActive(user);
    const refillTc = vip ? 1000 : 600;
    await db
      .update(usersTable)
      .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${refillTc}` })
      .where(eq(usersTable.telegramId, authedId));
    mysteryReward = { type: "tc", amount: refillTc };
  } else {
    await db.insert(gemInventoryTable).values({
      telegramId: authedId,
      gemType,
      usesRemaining: catalog.usesRemaining,
      expiresAt: expiryFromCatalog(catalog),
    });
  }

  const [updatedUser] = await db
    .select({ goldCoins: usersTable.goldCoins, tradeCredits: usersTable.tradeCredits })
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  res.status(201).json({
    success: true,
    gemType,
    gcSpent: catalog.gcCost,
    newGcBalance: updatedUser?.goldCoins ?? user.goldCoins,
    newTcBalance: updatedUser?.tradeCredits ?? user.tradeCredits,
    mysteryReward: mysteryReward ?? null,
  });
});

router.get("/gems/:telegramId/active", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const gems = await db
    .select()
    .from(gemInventoryTable)
    .where(
      and(
        eq(gemInventoryTable.telegramId, authedId),
        gt(gemInventoryTable.usesRemaining, 0),
        or(isNull(gemInventoryTable.expiresAt), gt(gemInventoryTable.expiresAt, new Date())),
      ),
    )
    .orderBy(gemInventoryTable.createdAt);

  res.json(serializeRows(gems as Record<string, unknown>[]));
});

export default router;

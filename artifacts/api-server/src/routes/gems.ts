import { Router, type IRouter } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db, gemInventoryTable, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { serializeRows, serializeRow } from "../lib/serialize";
import { z } from "zod/v4";
import { isVipActive } from "../lib/vip";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const GEM_CATALOG = {
  starter_boost: { tcCost: 300, usesRemaining: 3, vipOnly: false },
  big_swing: { tcCost: 750, usesRemaining: 2, vipOnly: false },
  streak_saver: { tcCost: 400, usesRemaining: 1, vipOnly: false },
  mystery_box: { tcCost: 200, usesRemaining: 1, vipOnly: false },
  daily_refill: { tcCost: 500, usesRemaining: 1, vipOnly: true },
  double_or_nothing: { tcCost: 0, usesRemaining: 1, vipOnly: false },
} as const;

type GemType = keyof typeof GEM_CATALOG;

const PurchaseGemBody = z.object({
  telegramId: z.string(),
  gemType: z.enum([
    "starter_boost",
    "big_swing",
    "streak_saver",
    "mystery_box",
    "daily_refill",
    "double_or_nothing",
  ]),
});

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

  if (catalog.tcCost > 0 && user.tradeCredits < catalog.tcCost) {
    res.status(400).json({ error: "Insufficient Trade Credits" });
    return;
  }

  let mysteryReward: { type: string; amount?: number; gem?: string } | undefined;

  if (catalog.tcCost > 0) {
    const updated = await db
      .update(usersTable)
      .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${catalog.tcCost}` })
      .where(
        and(
          eq(usersTable.telegramId, telegramId),
          gt(usersTable.tradeCredits, catalog.tcCost - 1),
        ),
      )
      .returning({ tradeCredits: usersTable.tradeCredits });

    if (!updated.length) {
      res.status(400).json({ error: "Insufficient Trade Credits" });
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
        .where(eq(usersTable.telegramId, telegramId));
      mysteryReward = { type: "tc", amount };
    } else {
      const bonusGems: GemType[] = ["starter_boost", "streak_saver"];
      const bonusGem = bonusGems[Math.floor(Math.random() * bonusGems.length)];
      const bonusCatalog = GEM_CATALOG[bonusGem];
      await db.insert(gemInventoryTable).values({
        telegramId,
        gemType: bonusGem,
        usesRemaining: bonusCatalog.usesRemaining,
      });
      mysteryReward = { type: "gem", gem: bonusGem };
    }
  } else {
    await db.insert(gemInventoryTable).values({
      telegramId,
      gemType,
      usesRemaining: catalog.usesRemaining,
    });
  }

  const [updatedUser] = await db
    .select({ tradeCredits: usersTable.tradeCredits })
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  res.status(201).json({
    success: true,
    gemType,
    tcSpent: catalog.tcCost,
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
      ),
    )
    .orderBy(gemInventoryTable.createdAt);

  res.json(serializeRows(gems as Record<string, unknown>[]));
});

export default router;

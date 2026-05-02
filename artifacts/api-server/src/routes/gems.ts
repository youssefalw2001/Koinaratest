import { Router, type IRouter } from "express";
import { eq, and, gt, or, isNull } from "drizzle-orm";
import { db, gemInventoryTable, usersTable, vipTxHashesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { serializeRows } from "../lib/serialize";
import { z } from "zod/v4";
import { isVipActive } from "../lib/vip";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { isPaymentTxHashUsed } from "../lib/paymentTxGuard";

const router: IRouter = Router();
const TONAPI_BASE = "https://tonapi.io/v2";
const getOperatorWallet = () => process.env.KOINARA_TON_WALLET;

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

  // ── Mines Power-ups (verified TON payment) ───────────────────────────────
  revenge_shield:   { gcCost: 0, tonCost: 200000000, usesRemaining: 1, vipOnly: false, category: "mines" },
  safe_reveal:      { gcCost: 0, tonCost: 100000000, usesRemaining: 1, vipOnly: false, category: "mines" },
  gem_magnet:       { gcCost: 0, tonCost: 150000000, usesRemaining: 3, vipOnly: false, category: "mines" },
  second_chance:    { gcCost: 0, tonCost: 250000000, usesRemaining: 1, vipOnly: false, category: "mines" },
} as const;

type GemType = keyof typeof GEM_CATALOG;
type MinesGemType = "revenge_shield" | "safe_reveal" | "gem_magnet" | "second_chance";

type TonApiAccount = { address: string };
type TonApiTx = { hash: string; utime: number; out_msgs: Array<{ destination?: { address?: string }; value?: number; decoded_body?: { text?: string } }> };
type TonApiTxList = { transactions: TonApiTx[] };

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

const MINES_GEM_TYPES = ["revenge_shield", "safe_reveal", "gem_magnet", "second_chance"] as const;

const PurchaseGemBody = z.object({
  telegramId: z.string(),
  gemType: z.enum(ALL_GEM_TYPES),
});

const MinesPowerupQuery = z.object({
  telegramId: z.string().min(1),
  gemType: z.enum(MINES_GEM_TYPES),
});

const MinesPowerupBody = z.object({
  telegramId: z.string().min(1),
  gemType: z.enum(MINES_GEM_TYPES),
  senderAddress: z.string().min(1),
});

function expiryFromCatalog(catalog: (typeof GEM_CATALOG)[GemType]): Date | null {
  const hours = "expiresHours" in catalog ? catalog.expiresHours : null;
  return typeof hours === "number" && hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
}

function minesPowerupMemo(telegramId: string, gemType: MinesGemType): string {
  return `KNR-GEM-${gemType}-${telegramId}`;
}

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch {
    return { data: null, err: "TON API unreachable" };
  }
}

async function verifyTonPayment(senderAddress: string, expectedNano: bigint, expectedMemo: string): Promise<{ ok: boolean; err?: string; txHash?: string }> {
  const walletEnv = getOperatorWallet();
  if (!walletEnv) return { ok: false, err: "TON payment processing is not configured." };

  const { data: operatorAccount } = await tonapiGet<TonApiAccount>(`/accounts/${encodeURIComponent(walletEnv)}`);
  if (!operatorAccount) return { ok: false, err: "TON API unreachable — please retry." };

  const { data: txList } = await tonapiGet<TonApiTxList>(`/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`);
  if (!txList) return { ok: false, err: "TON API unreachable — please retry." };

  const minNano = (expectedNano * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const tx of txList.transactions) {
    if (nowSec - (tx.utime ?? 0) > 15 * 60) continue;
    for (const msg of tx.out_msgs) {
      if ((msg.destination?.address ?? "") !== operatorAccount.address) continue;
      if (BigInt(Math.floor(msg.value ?? 0)) < minNano) continue;
      if ((msg.decoded_body?.text ?? "") !== expectedMemo) continue;
      return { ok: true, txHash: tx.hash };
    }
  }

  return { ok: false, err: `No matching TON payment found within 15 minutes. Include exact memo/comment "${expectedMemo}".` };
}

router.get("/gems/powerups/memo", (req, res): void => {
  const parsed = MinesPowerupQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const operatorWallet = getOperatorWallet();
  if (!operatorWallet) { res.status(503).json({ error: "TON payment wallet is not configured." }); return; }

  const catalog = GEM_CATALOG[parsed.data.gemType];
  res.json({
    gemType: parsed.data.gemType,
    memo: minesPowerupMemo(telegramId, parsed.data.gemType),
    operatorWallet,
    amountNano: String(catalog.tonCost),
  });
});

router.post("/gems/powerups/purchase", async (req, res): Promise<void> => {
  const parsed = MinesPowerupBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body." }); return; }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const catalog = GEM_CATALOG[parsed.data.gemType];
  const requiredMemo = minesPowerupMemo(telegramId, parsed.data.gemType);
  const verification = await verifyTonPayment(parsed.data.senderAddress, BigInt(catalog.tonCost), requiredMemo);
  if (!verification.ok) { res.status(422).json({ error: verification.err ?? "Payment verification failed.", requiredMemo }); return; }

  const txHash = verification.txHash;
  if (!txHash) { res.status(500).json({ error: "TON verifier returned no tx hash." }); return; }
  if (await isPaymentTxHashUsed(txHash)) { res.status(409).json({ error: "This transaction has already been used for a purchase." }); return; }

  try {
    const [insertedGem] = await db.transaction(async (tx) => {
      await tx.insert(vipTxHashesTable).values({ txHash, telegramId, plan: `gem_${parsed.data.gemType}` });
      return tx.insert(gemInventoryTable).values({
        telegramId,
        gemType: parsed.data.gemType,
        usesRemaining: catalog.usesRemaining,
        expiresAt: expiryFromCatalog(catalog),
      }).returning();
    });

    res.status(201).json({
      success: true,
      gemId: insertedGem.id,
      gemType: parsed.data.gemType,
      usesRemaining: insertedGem.usesRemaining,
      tonSpent: catalog.tonCost,
    });
  } catch (err: any) {
    if (err?.code === "23505") { res.status(409).json({ error: "This transaction has already been used for a purchase." }); return; }
    res.status(500).json({ error: "Failed to grant Mines power-up." });
  }
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

  if (catalog.category === "mines") {
    res.status(402).json({ error: "Mines power-ups require verified TON payment. Use /gems/powerups/purchase." });
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

import { Router, type IRouter } from "express";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, crTransactionsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { serializeRow } from "../lib/serialize";
import { logger } from "../lib/logger";

export const CR_PER_USD = 1000;
const REVIEW_HOURS = 48;

type PurchaseSourceType =
  | "vip_purchase"
  | "creator_pass"
  | "vip_renewal"
  | "tc_pack"
  | "mines_pass"
  | "content";

type PurchaseEvent = {
  buyerTelegramId: string;
  purchaseType: PurchaseSourceType | string;
  grossUsd: number;
  isRenewal: boolean;
};

const router: IRouter = Router();

function normalizeSourceType(purchaseType: string, isRenewal: boolean): PurchaseSourceType {
  if (isRenewal || purchaseType === "vip_renewal") return "vip_renewal";
  if (["vip_purchase", "creator_pass", "tc_pack", "mines_pass", "content"].includes(purchaseType)) return purchaseType as PurchaseSourceType;
  return "content";
}

async function approveMatureCrTransactions(): Promise<void> {
  const cutoff = new Date(Date.now() - REVIEW_HOURS * 60 * 60 * 1000);
  await db
    .update(crTransactionsTable)
    .set({ status: "approved", approvedAt: new Date() })
    .where(and(eq(crTransactionsTable.status, "pending"), lte(crTransactionsTable.createdAt, cutoff)));
}

export async function processCommission(purchaseEvent: PurchaseEvent): Promise<void> {
  const { buyerTelegramId, grossUsd, isRenewal } = purchaseEvent;
  if (!buyerTelegramId || grossUsd <= 0) return;

  const sourceType = normalizeSourceType(purchaseEvent.purchaseType, isRenewal);
  const [buyer] = await db.select().from(usersTable).where(eq(usersTable.telegramId, buyerTelegramId)).limit(1);
  if (!buyer?.referredBy) return;

  const [level1Creator] = await db.select().from(usersTable).where(eq(usersTable.telegramId, buyer.referredBy)).limit(1);
  if (!level1Creator?.creatorPassPaid) return;

  const level1Cr = Math.floor(grossUsd * 0.2 * CR_PER_USD);
  if (level1Cr > 0) {
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({
        creatorCredits: sql`${usersTable.creatorCredits} + ${level1Cr}`,
        totalCrEarned: sql`${usersTable.totalCrEarned} + ${level1Cr}`,
      }).where(eq(usersTable.telegramId, level1Creator.telegramId));

      await tx.insert(crTransactionsTable).values({
        telegramId: level1Creator.telegramId,
        type: isRenewal ? "commission_renewal" : "commission_l1",
        crAmount: level1Cr,
        sourceType,
        sourceTelegramId: buyerTelegramId,
        usdEquivalent: level1Cr / CR_PER_USD,
        status: "pending",
      });
    });
  }

  if (!level1Creator.referredBy) return;
  const [level2Creator] = await db.select().from(usersTable).where(eq(usersTable.telegramId, level1Creator.referredBy)).limit(1);
  if (!level2Creator?.creatorPassPaid) return;

  const level2Cr = Math.floor(grossUsd * 0.05 * CR_PER_USD);
  if (level2Cr <= 0) return;

  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({
      creatorCredits: sql`${usersTable.creatorCredits} + ${level2Cr}`,
      totalCrEarned: sql`${usersTable.totalCrEarned} + ${level2Cr}`,
    }).where(eq(usersTable.telegramId, level2Creator.telegramId));

    await tx.insert(crTransactionsTable).values({
      telegramId: level2Creator.telegramId,
      type: "commission_l2",
      crAmount: level2Cr,
      sourceType,
      sourceTelegramId: buyerTelegramId,
      usdEquivalent: level2Cr / CR_PER_USD,
      status: "pending",
    });
  });

  logger.info({ buyerTelegramId, sourceType, grossUsd, level1Cr, level2Cr }, "Creator commission processed");
}

export async function getApprovedCreatorCrBalance(telegramId: string): Promise<number> {
  await approveMatureCrTransactions();
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${crTransactionsTable.crAmount}), 0)` })
    .from(crTransactionsTable)
    .where(and(eq(crTransactionsTable.telegramId, telegramId), eq(crTransactionsTable.status, "approved")));
  return Number(rows[0]?.total ?? 0);
}

router.get("/creator/leaderboard", async (_req, res): Promise<void> => {
  await approveMatureCrTransactions();
  const rows = await db
    .select({
      telegramId: usersTable.telegramId,
      username: usersTable.username,
      firstName: usersTable.firstName,
      creatorCredits: usersTable.creatorCredits,
      totalCrEarned: usersTable.totalCrEarned,
    })
    .from(usersTable)
    .where(eq(usersTable.creatorPassPaid, true))
    .orderBy(desc(usersTable.totalCrEarned))
    .limit(10);

  res.json({
    rate: "1,000 CR = $1.00",
    rows: rows.map((row, index) => ({ ...serializeRow(row as Record<string, unknown>), rank: index + 1 })),
  });
});

router.get("/creator/:telegramId/cr-summary", async (req, res): Promise<void> => {
  const parsed = z.object({ telegramId: z.string().min(1) }).safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: "telegramId required" }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  await approveMatureCrTransactions();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const rows = await db.select().from(crTransactionsTable).where(eq(crTransactionsTable.telegramId, telegramId)).orderBy(desc(crTransactionsTable.createdAt)).limit(50);
  const sum = (type: string) => rows.filter((r) => r.type === type && r.crAmount > 0).reduce((acc, r) => acc + r.crAmount, 0);
  const pendingCr = rows.filter((r) => r.status === "pending" && r.crAmount > 0).reduce((acc, r) => acc + r.crAmount, 0);
  const approvedCr = rows.filter((r) => r.status === "approved").reduce((acc, r) => acc + r.crAmount, 0);
  const directReferralCount = await db.select({ count: sql<number>`COUNT(*)` }).from(usersTable).where(eq(usersTable.referredBy, telegramId));
  const directReferralIds = await db.select({ telegramId: usersTable.telegramId }).from(usersTable).where(eq(usersTable.referredBy, telegramId));
  let level2Count = 0;
  if (directReferralIds.length > 0) {
    for (const direct of directReferralIds) {
      const [countRow] = await db.select({ count: sql<number>`COUNT(*)` }).from(usersTable).where(eq(usersTable.referredBy, direct.telegramId));
      level2Count += Number(countRow?.count ?? 0);
    }
  }

  res.json({
    creatorCredits: user.creatorCredits ?? 0,
    totalCrEarned: user.totalCrEarned ?? 0,
    totalCrWithdrawn: user.totalCrWithdrawn ?? 0,
    pendingCr,
    approvedCr,
    withdrawableCr: Math.max(0, approvedCr),
    directCommissionCr: sum("commission_l1"),
    networkCommissionCr: sum("commission_l2"),
    renewalCommissionCr: sum("commission_renewal"),
    contentRewardCr: sum("content_reward") + sum("retention_bonus"),
    directReferralCount: Number(directReferralCount[0]?.count ?? 0),
    level2ReferralCount: level2Count,
    vipReferralCount: 0,
    networkPurchaseCount: rows.filter((r) => r.crAmount > 0 && r.sourceTelegramId).length,
    transactions: rows.map((r) => serializeRow(r as Record<string, unknown>)),
    note: "Commissions are approved after 48 hour review. 1,000 CR = $1.00.",
  });
});

export default router;

import { Router, type IRouter } from "express";
import { eq, desc, sql, lt, and } from "drizzle-orm";
import { db, usersTable, crTransactionsTable } from "@workspace/db";
import { isVipActive } from "../lib/vip";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export interface ProcessCommissionParams {
  buyerTelegramId: string;
  purchaseType: "vip_purchase" | "creator_pass" | "tc_pack";
  grossUsd: number;
  isRenewal?: boolean;
}

/**
 * Processes CR commissions for a purchase event.
 *
 * L1 referrer earns 20% (25% if Gold/Elite rank ≥25 direct referrals).
 * L2 referrer earns 5%.
 * Both require creatorPassPaid=true or active VIP.
 * CR is credited immediately but status="pending" for 48h hold.
 */
export async function processCommission(params: ProcessCommissionParams): Promise<void> {
  const { buyerTelegramId, purchaseType, grossUsd, isRenewal = false } = params;
  const now = new Date();

  // Step 1: Find buyer's referrer
  const [buyer] = await db
    .select({ referredBy: usersTable.referredBy })
    .from(usersTable)
    .where(eq(usersTable.telegramId, buyerTelegramId))
    .limit(1);

  if (!buyer?.referredBy) return;

  // Step 2: Find L1 referrer
  const [l1Referrer] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, buyer.referredBy))
    .limit(1);

  if (!l1Referrer) return;

  // Step 3: Check L1 has Creator Pass (VIP also qualifies per product spec)
  const l1HasCreatorAccess = l1Referrer.creatorPassPaid || isVipActive(l1Referrer);
  if (!l1HasCreatorAccess) return;

  // Step 4: Determine L1 commission rate based on rank
  const [l1CountRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.referredBy, l1Referrer.telegramId));
  const l1DirectCount = l1CountRow?.cnt ?? 0;

  const l1Rate = l1DirectCount >= 25 ? 0.25 : 0.20;
  const l1Cr = Math.floor(grossUsd * l1Rate * 1000);

  const maturesAt = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const l1Type = isRenewal ? "commission_renewal" : "commission_l1";

  // Step 5: Credit L1 referrer
  await db
    .update(usersTable)
    .set({
      creatorCredits: sql`${usersTable.creatorCredits} + ${l1Cr}`,
      totalCrEarned: sql`${usersTable.totalCrEarned} + ${l1Cr}`,
    })
    .where(eq(usersTable.telegramId, l1Referrer.telegramId));

  // Step 6: Insert CR transaction record
  await db.insert(crTransactionsTable).values({
    referrerTelegramId: l1Referrer.telegramId,
    sourceTelegramId: buyerTelegramId,
    purchaseType,
    grossUsd: String(grossUsd),
    crAmount: l1Cr,
    level: 1,
    type: l1Type,
    status: "pending",
    maturesAt,
  });

  logger.info(
    { referrer: l1Referrer.telegramId, buyer: buyerTelegramId, l1Cr, purchaseType },
    "L1 CR commission credited",
  );

  // Step 7: Find L2 referrer
  if (!l1Referrer.referredBy) return;

  const [l2Referrer] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, l1Referrer.referredBy))
    .limit(1);

  if (!l2Referrer) return;

  // Step 8: Check L2 has Creator Pass
  const l2HasCreatorAccess = l2Referrer.creatorPassPaid || isVipActive(l2Referrer);
  if (!l2HasCreatorAccess) return;

  const l2Cr = Math.floor(grossUsd * 0.05 * 1000);

  await db
    .update(usersTable)
    .set({
      creatorCredits: sql`${usersTable.creatorCredits} + ${l2Cr}`,
      totalCrEarned: sql`${usersTable.totalCrEarned} + ${l2Cr}`,
    })
    .where(eq(usersTable.telegramId, l2Referrer.telegramId));

  await db.insert(crTransactionsTable).values({
    referrerTelegramId: l2Referrer.telegramId,
    sourceTelegramId: buyerTelegramId,
    purchaseType,
    grossUsd: String(grossUsd),
    crAmount: l2Cr,
    level: 2,
    type: "commission_l2",
    status: "pending",
    maturesAt,
  });

  logger.info(
    { referrer: l2Referrer.telegramId, buyer: buyerTelegramId, l2Cr, purchaseType },
    "L2 CR commission credited",
  );
}

/**
 * Approves all pending CR transactions that have passed the 48-hour hold.
 * Called by scheduled job every hour.
 */
export async function approveMatureCrTransactions(): Promise<{ approved: number }> {
  const now = new Date();
  const result = await db
    .update(crTransactionsTable)
    .set({ status: "approved" })
    .where(
      and(
        eq(crTransactionsTable.status, "pending"),
        lt(crTransactionsTable.maturesAt, now),
      ),
    )
    .returning({ id: crTransactionsTable.id });

  return { approved: result.length };
}

// ── GET /creator/cr-summary/:telegramId ─────────────────────────────────────
router.get("/creator/cr-summary/:telegramId", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [user] = await db
    .select({
      creatorCredits: usersTable.creatorCredits,
      totalCrEarned: usersTable.totalCrEarned,
      creatorPassPaid: usersTable.creatorPassPaid,
    })
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [directCountRow] = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.referredBy, authedId));
  const directCount = directCountRow?.cnt ?? 0;

  const directReferralIds = await db
    .select({ telegramId: usersTable.telegramId })
    .from(usersTable)
    .where(eq(usersTable.referredBy, authedId));

  let indirectCount = 0;
  if (directReferralIds.length > 0) {
    const ids = directReferralIds.map(r => r.telegramId);
    const [indirectRow] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(sql`${usersTable.referredBy} = ANY(${ids})`);
    indirectCount = indirectRow?.cnt ?? 0;
  }

  // Recent pending transactions
  const pendingTxs = await db
    .select()
    .from(crTransactionsTable)
    .where(
      and(
        eq(crTransactionsTable.referrerTelegramId, authedId),
        eq(crTransactionsTable.status, "pending"),
      ),
    )
    .orderBy(desc(crTransactionsTable.createdAt))
    .limit(10);

  const pendingCr = pendingTxs.reduce((sum, tx) => sum + tx.crAmount, 0);

  res.json({
    creatorCredits: user.creatorCredits,
    totalCrEarned: user.totalCrEarned,
    creatorPassPaid: user.creatorPassPaid,
    directReferralCount: directCount,
    indirectReferralCount: indirectCount,
    pendingCr,
    pendingTransactions: pendingTxs.length,
  });
});

// ── GET /creator/leaderboard ─────────────────────────────────────────────────
router.get("/creator/leaderboard", async (_req, res): Promise<void> => {
  await approveMatureCrTransactions();

  const top = await db
    .select({
      telegramId: usersTable.telegramId,
      username: usersTable.username,
      firstName: usersTable.firstName,
      totalCrEarned: usersTable.totalCrEarned,
      creatorCredits: usersTable.creatorCredits,
    })
    .from(usersTable)
    .where(sql`${usersTable.totalCrEarned} > 0`)
    .orderBy(desc(usersTable.totalCrEarned))
    .limit(20);

  res.json(top.map((u, idx) => ({
    rank: idx + 1,
    telegramId: u.telegramId,
    username: u.username ?? u.firstName ?? "Creator",
    totalCrEarned: u.totalCrEarned,
    creatorCredits: u.creatorCredits,
    estimatedUsd: (u.totalCrEarned / 1000).toFixed(2),
  })));
});

// ── GET /debug/referral-chain/:telegramId ────────────────────────────────────
// Dev/staging only — gated by NODE_ENV or ADMIN_SECRET header
router.get("/debug/referral-chain/:telegramId", async (req, res): Promise<void> => {
  const isProduction = process.env.NODE_ENV === "production";
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = req.headers["x-admin-secret"];

  if (isProduction && (!adminSecret || providedSecret !== adminSecret)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { telegramId } = req.params;

  const [user] = await db
    .select({ telegramId: usersTable.telegramId, referredBy: usersTable.referredBy })
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let referrer = null;
  let referrerOfReferrer = null;

  if (user.referredBy) {
    const [r] = await db
      .select({
        telegramId: usersTable.telegramId,
        username: usersTable.username,
        creatorPassPaid: usersTable.creatorPassPaid,
        isVip: usersTable.isVip,
        vipExpiresAt: usersTable.vipExpiresAt,
        referredBy: usersTable.referredBy,
      })
      .from(usersTable)
      .where(eq(usersTable.telegramId, user.referredBy))
      .limit(1);

    if (r) {
      referrer = { telegramId: r.telegramId, username: r.username, creatorPassPaid: r.creatorPassPaid, isVip: r.isVip };

      if (r.referredBy) {
        const [r2] = await db
          .select({ telegramId: usersTable.telegramId, username: usersTable.username })
          .from(usersTable)
          .where(eq(usersTable.telegramId, r.referredBy))
          .limit(1);
        if (r2) referrerOfReferrer = { telegramId: r2.telegramId, username: r2.username };
      }
    }
  }

  const recentCommissions = await db
    .select()
    .from(crTransactionsTable)
    .where(eq(crTransactionsTable.sourceTelegramId, telegramId))
    .orderBy(desc(crTransactionsTable.createdAt))
    .limit(5);

  const [totalRow] = await db
    .select({ total: sql<number>`coalesce(sum(${crTransactionsTable.crAmount}), 0)::int` })
    .from(crTransactionsTable)
    .where(eq(crTransactionsTable.sourceTelegramId, telegramId));

  res.json({
    user: telegramId,
    referredBy: user.referredBy,
    referrer,
    referrerOfReferrer,
    totalCommissionsGenerated: totalRow?.total ?? 0,
    recentCommissions,
  });
});

export default router;

import { Router, type IRouter } from "express";
import { eq, sql, desc, and, gte } from "drizzle-orm";
import { db, usersTable, withdrawalQueueTable, platformDailyStatsTable } from "@workspace/db";
import { z } from "zod";
import { serializeRow } from "../lib/serialize";

const router: IRouter = Router();

// ─── Rates & caps ───────────────────────────────────────────────────────────
// Free tier: 4,000 GC = $1 | VIP tier: 2,500 GC = $1
const FREE_GC_PER_USD = 4000;
const VIP_GC_PER_USD  = 2500;

const FREE_MIN_GC      = 10000;  // $2.50
const VIP_MIN_GC       = 2500;   // $1.00

const FREE_WEEKLY_MAX_USD = 25;   // $25/week → 100,000 GC
const VIP_WEEKLY_MAX_USD  = 100;  // $100/week → 250,000 GC

const FEE_PCT = 0.025;  // 2.5% on every withdrawal

// Operator daily payout cap: total paid-out GC must not exceed 50% of previous day's revenue GC
const DAILY_PAYOUT_RATIO = 0.5;

function getWeekStart(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon
  const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1); // roll back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().split("T")[0];
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Zod validators ──────────────────────────────────────────────────────────
const RequestWithdrawalBody = z.object({
  telegramId: z.string(),
  gcAmount: z.number().int().positive(),
  usdtWallet: z.string().min(10, "Enter a valid USDT TRC-20 wallet address"),
});

const UpdateWithdrawalStatusBody = z.object({
  status: z.enum(["pending", "processing", "complete", "failed"]),
  txHash: z.string().optional(),
});

// ─── POST /withdrawals/request ───────────────────────────────────────────────
router.post("/withdrawals/request", async (req, res): Promise<void> => {
  const body = RequestWithdrawalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const { telegramId, gcAmount, usdtWallet } = body.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const isVipUser = !!(user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date()) ||
    !!(user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > new Date());

  const gcPerUsd   = isVipUser ? VIP_GC_PER_USD  : FREE_GC_PER_USD;
  const minGc      = isVipUser ? VIP_MIN_GC       : FREE_MIN_GC;
  const weeklyMaxUsd = isVipUser ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;

  // ── Minimum check
  if (gcAmount < minGc) {
    const shortfall = minGc - gcAmount;
    res.status(400).json({
      error: `Minimum withdrawal is ${minGc.toLocaleString()} GC ($${(minGc / gcPerUsd).toFixed(2)}). You need ${shortfall.toLocaleString()} more GC.`,
    });
    return;
  }

  // ── Balance check
  if (user.goldCoins < gcAmount) {
    res.status(400).json({ error: `Insufficient balance. You have ${user.goldCoins.toLocaleString()} GC.` });
    return;
  }

  // ── Weekly cap: reset if week changed
  const weekStart = getWeekStart();
  let weeklyUsedGc = user.weeklyWithdrawnGc ?? 0;
  if (!user.weeklyWithdrawnResetAt || user.weeklyWithdrawnResetAt < weekStart) {
    weeklyUsedGc = 0;
  }

  const weeklyMaxGc = weeklyMaxUsd * gcPerUsd;
  if (weeklyUsedGc + gcAmount > weeklyMaxGc) {
    const remaining = Math.max(0, weeklyMaxGc - weeklyUsedGc);
    const remainingUsd = (remaining / gcPerUsd).toFixed(2);
    res.status(400).json({
      error: `Weekly withdrawal limit reached. You can withdraw up to $${remainingUsd} more this week (resets Monday).`,
      weeklyRemainingGc: remaining,
    });
    return;
  }

  // ── Daily operator cap: check previous day's revenue
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const [prevDayStats] = await db
    .select()
    .from(platformDailyStatsTable)
    .where(eq(platformDailyStatsTable.date, yesterdayStr))
    .limit(1);

  if (prevDayStats && prevDayStats.totalRevenueGc > 0) {
    const maxDailyPayoutGc = Math.floor(prevDayStats.totalRevenueGc * DAILY_PAYOUT_RATIO);
    const [todayStats] = await db
      .select()
      .from(platformDailyStatsTable)
      .where(eq(platformDailyStatsTable.date, todayStr()))
      .limit(1);

    const paidOutToday = todayStats?.totalPaidOutGc ?? 0;
    if (paidOutToday + gcAmount > maxDailyPayoutGc) {
      res.status(503).json({
        error: "Daily payout limit reached. Please try again tomorrow.",
      });
      return;
    }
  }

  // ── Compute fee
  const feeGc  = Math.floor(gcAmount * FEE_PCT);
  const netGc  = gcAmount - feeGc;
  const usdValue = gcAmount / gcPerUsd;
  const netUsd   = netGc / gcPerUsd;

  // ── Estimated processing time
  const tier = isVipUser ? "vip" : "free";

  // ── Atomic: deduct GC + insert queue entry + update weekly counter
  await db.transaction(async (tx) => {
    const weeklyUpdate: Record<string, unknown> = {
      goldCoins: sql`${usersTable.goldCoins} - ${gcAmount}`,
      weeklyWithdrawnGc: sql`CASE WHEN ${usersTable.weeklyWithdrawnResetAt} IS NULL OR ${usersTable.weeklyWithdrawnResetAt} < ${weekStart} THEN ${gcAmount} ELSE ${usersTable.weeklyWithdrawnGc} + ${gcAmount} END`,
      weeklyWithdrawnResetAt: weekStart,
    };

    // Mark verified on first successful withdrawal (user confirmed identity via TON verification fee flow)
    if (!user.hasVerified) {
      weeklyUpdate.hasVerified = true;
    }

    await tx
      .update(usersTable)
      .set(weeklyUpdate)
      .where(and(
        eq(usersTable.telegramId, telegramId),
        gte(usersTable.goldCoins, gcAmount),
      ));

    await tx.insert(withdrawalQueueTable).values({
      telegramId,
      amountGc: gcAmount,
      feePct: FEE_PCT,
      feeGc,
      netGc,
      usdValue,
      netUsd,
      walletAddress: usdtWallet,
      isVip: isVipUser ? 1 : 0,
      tier,
      status: "pending",
    });

    // Track today's paid-out GC for daily cap
    await tx
      .insert(platformDailyStatsTable)
      .values({ date: todayStr(), totalPaidOutGc: gcAmount })
      .onConflictDoUpdate({
        target: platformDailyStatsTable.date,
        set: { totalPaidOutGc: sql`platform_daily_stats.total_paid_out_gc + ${gcAmount}` },
      });
  });

  // Re-fetch updated user
  const [updated] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  const weeklyRemainingGc = Math.max(0, weeklyMaxGc - (weeklyUsedGc + gcAmount));
  const weeklyRemainingUsd = (weeklyRemainingGc / gcPerUsd).toFixed(2);

  res.json({
    success: true,
    gcDeducted: gcAmount,
    netUsd: parseFloat(netUsd.toFixed(4)),
    feeUsd: parseFloat((feeGc / gcPerUsd).toFixed(4)),
    estimatedTime: isVipUser ? "~4 hours" : "48–72 hours",
    weeklyRemainingUsd,
    newGcBalance: updated?.goldCoins ?? 0,
  });
});

// ─── GET /withdrawals/:telegramId ─────────────────────────────────────────────
router.get("/withdrawals/:telegramId", async (req, res): Promise<void> => {
  const telegramId = req.params.telegramId;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const rows = await db
    .select()
    .from(withdrawalQueueTable)
    .where(eq(withdrawalQueueTable.telegramId, telegramId))
    .orderBy(desc(withdrawalQueueTable.createdAt))
    .limit(50);

  res.json(rows.map(r => serializeRow(r as Record<string, unknown>)));
});

// ─── PATCH /withdrawals/:id/status  (admin-facing) ─────────────────────────
router.patch("/withdrawals/:id/status", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid withdrawal id" });
    return;
  }

  const body = UpdateWithdrawalStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid body" });
    return;
  }

  const { status, txHash } = body.data;

  const updateData: Record<string, unknown> = { status };
  if (txHash) updateData.txHash = txHash;
  if (status === "complete" || status === "processing") {
    updateData.processesAt = new Date();
  }

  const [updated] = await db
    .update(withdrawalQueueTable)
    .set(updateData)
    .where(eq(withdrawalQueueTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Withdrawal not found" });
    return;
  }

  res.json(serializeRow(updated as Record<string, unknown>));
});

export default router;

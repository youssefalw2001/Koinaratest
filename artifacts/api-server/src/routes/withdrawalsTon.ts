import { Router, type IRouter } from "express";
import { and, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, withdrawalQueueTable, platformDailyStatsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const FREE_MIN_GC = 14000;
const VIP_MIN_GC = 2500;
const FREE_WEEKLY_MAX_USD = 25;
const VIP_WEEKLY_MAX_USD = 100;
const FEE_PCT = 0.06;
const DAILY_PAYOUT_RATIO = 0.5;
const WITHDRAWAL_COOLDOWN_MS = 3 * 60_000;
const WITHDRAWAL_MAX_24H_COUNT = 6;
const TON_ADDRESS_REGEX = /^[A-Za-z0-9:_-]{20,120}$/;

const Body = z.object({
  telegramId: z.string().min(1),
  gcAmount: z.number().int().positive(),
  walletAddress: z.string().regex(TON_ADDRESS_REGEX, "Invalid TON wallet address."),
});

function getWeekStart(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff)).toISOString().split("T")[0];
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

async function hasActiveVipReferral(telegramId: string): Promise<boolean> {
  const [vipReferral] = await db
    .select({ telegramId: usersTable.telegramId })
    .from(usersTable)
    .where(and(eq(usersTable.referredBy, telegramId), eq(usersTable.isVip, true), gt(usersTable.vipExpiresAt, new Date())))
    .limit(1);
  return Boolean(vipReferral);
}

router.post("/withdrawals/request-ton", async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid USDT TON withdrawal request." });
    return;
  }

  const { telegramId, gcAmount, walletAddress } = parsed.data;
  const idempotency = await beginIdempotency(req, {
    scope: "withdrawals.request-ton",
    requireHeader: true,
    fingerprintData: { telegramId, gcAmount, walletAddress, payoutNetwork: "usdt_ton" },
    ttlMs: 6 * 60 * 60 * 1000,
  });
  if (idempotency.kind === "missing") { res.status(400).json({ error: idempotency.message }); return; }
  if (idempotency.kind === "replay") { res.status(idempotency.statusCode).json(idempotency.responseBody); return; }
  if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") { res.status(409).json({ error: idempotency.message }); return; }
  if (idempotency.kind !== "acquired") { res.status(500).json({ error: "Idempotency precondition failed." }); return; }
  const handle = idempotency;
  const reply = async (statusCode: number, payload: unknown) => {
    await handle.commit(statusCode, payload);
    res.status(statusCode).json(payload);
  };

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) { await handle.abort(); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) { await handle.abort(); res.status(404).json({ error: "User not found" }); return; }

  const recentThreshold = new Date(Date.now() - WITHDRAWAL_COOLDOWN_MS);
  const [recent] = await db
    .select({ id: withdrawalQueueTable.id })
    .from(withdrawalQueueTable)
    .where(and(eq(withdrawalQueueTable.telegramId, authedId), gt(withdrawalQueueTable.createdAt, recentThreshold)))
    .limit(1);
  if (recent) {
    logger.warn({ telegramId: authedId, gcAmount }, "USDT TON withdrawal blocked by cooldown guard");
    await reply(429, { error: "Withdrawal cooldown active. Please wait a few minutes before requesting again.", code: "WITHDRAWAL_COOLDOWN" });
    return;
  }

  const dayThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last24hRows = await db
    .select({ id: withdrawalQueueTable.id })
    .from(withdrawalQueueTable)
    .where(and(eq(withdrawalQueueTable.telegramId, authedId), gt(withdrawalQueueTable.createdAt, dayThreshold)));
  if (last24hRows.length >= WITHDRAWAL_MAX_24H_COUNT) {
    logger.warn({ telegramId: authedId, last24hCount: last24hRows.length }, "USDT TON withdrawal blocked by daily velocity guard");
    await reply(429, { error: "Too many withdrawal requests in the last 24 hours. Please try later.", code: "WITHDRAWAL_DAILY_VELOCITY" });
    return;
  }

  const now = new Date();
  const isVipUser = !!(user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now) || !!(user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > now);
  const hasVipReferralWaiver = !isVipUser && !user.hasVerified ? await hasActiveVipReferral(authedId) : false;
  if (!isVipUser && !user.hasVerified && !hasVipReferralWaiver) {
    await reply(403, { error: "One-time withdrawal verification required before gameplay GC withdrawals.", code: "VERIFICATION_REQUIRED" });
    return;
  }

  const gcPerUsd = isVipUser ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const minGc = isVipUser ? VIP_MIN_GC : FREE_MIN_GC;
  const weeklyMaxUsd = isVipUser ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;
  const weeklyMaxGc = weeklyMaxUsd * gcPerUsd;
  if (gcAmount < minGc) { await reply(400, { error: `Minimum withdrawal is ${minGc.toLocaleString()} GC ($${(minGc / gcPerUsd).toFixed(2)}). You need ${(minGc - gcAmount).toLocaleString()} more GC.` }); return; }
  if ((user.goldCoins ?? 0) < gcAmount) { await reply(400, { error: `Insufficient balance. You have ${(user.goldCoins ?? 0).toLocaleString()} GC.` }); return; }

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const [prevDayStats] = await db.select().from(platformDailyStatsTable).where(eq(platformDailyStatsTable.date, yesterdayStr)).limit(1);
  const maxDailyPayoutGc = Math.floor((prevDayStats?.totalRevenueGc ?? 0) * DAILY_PAYOUT_RATIO);

  const feeGc = Math.floor(gcAmount * FEE_PCT);
  const netGc = gcAmount - feeGc;
  const usdValue = gcAmount / gcPerUsd;
  const netUsd = netGc / gcPerUsd;
  const tier = isVipUser ? "vip" : "free";
  const weekStart = getWeekStart();
  let weeklyRemainingGc = 0;

  try {
    await db.transaction(async (tx) => {
      const userUpdate: Record<string, unknown> = {
        goldCoins: sql`${usersTable.goldCoins} - ${gcAmount}`,
        weeklyWithdrawnGc: sql`CASE WHEN ${usersTable.weeklyWithdrawnResetAt} IS NULL OR ${usersTable.weeklyWithdrawnResetAt} < ${weekStart} THEN ${gcAmount} ELSE ${usersTable.weeklyWithdrawnGc} + ${gcAmount} END`,
        weeklyWithdrawnResetAt: weekStart,
      };
      if (hasVipReferralWaiver) userUpdate.hasVerified = true;

      const updated = await tx.update(usersTable).set(userUpdate).where(and(
        eq(usersTable.telegramId, authedId),
        gte(usersTable.goldCoins, gcAmount),
        sql`(CASE WHEN ${usersTable.weeklyWithdrawnResetAt} IS NULL OR ${usersTable.weeklyWithdrawnResetAt} < ${weekStart} THEN ${gcAmount} ELSE ${usersTable.weeklyWithdrawnGc} + ${gcAmount} END) <= ${weeklyMaxGc}`,
      )).returning();

      if (updated.length === 0) {
        const [fresh] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
        if (!fresh || fresh.goldCoins < gcAmount) throw new Error("INSUFFICIENT_BALANCE");
        const freshWeekly = (!fresh.weeklyWithdrawnResetAt || fresh.weeklyWithdrawnResetAt < weekStart) ? 0 : (fresh.weeklyWithdrawnGc ?? 0);
        const remaining = Math.max(0, weeklyMaxGc - freshWeekly);
        throw Object.assign(new Error("WEEKLY_CAP_EXCEEDED"), { weeklyRemainingGc: remaining, remainingUsd: (remaining / gcPerUsd).toFixed(2) });
      }

      const updatedRow = updated[0]!;
      weeklyRemainingGc = Math.max(0, weeklyMaxGc - (updatedRow.weeklyWithdrawnGc ?? gcAmount));

      await tx.insert(platformDailyStatsTable).values({ date: todayStr(), totalPaidOutGc: 0 }).onConflictDoNothing();
      const [dailyUpdated] = await tx.update(platformDailyStatsTable).set({ totalPaidOutGc: sql`${platformDailyStatsTable.totalPaidOutGc} + ${gcAmount}` }).where(and(
        eq(platformDailyStatsTable.date, todayStr()),
        sql`${platformDailyStatsTable.totalPaidOutGc} + ${gcAmount} <= ${maxDailyPayoutGc}`,
      )).returning();
      if (!dailyUpdated) throw new Error("DAILY_CAP_EXCEEDED");

      await tx.insert(withdrawalQueueTable).values({
        telegramId: authedId,
        amountGc: gcAmount,
        feePct: FEE_PCT,
        feeGc,
        netGc,
        usdValue,
        netUsd,
        walletAddress,
        payoutNetwork: "usdt_ton",
        isVip: isVipUser ? 1 : 0,
        tier,
        status: "pending",
      });
    });
  } catch (err: unknown) {
    const e = err as Error & { weeklyRemainingGc?: number; remainingUsd?: string };
    if (e.message === "INSUFFICIENT_BALANCE") { logger.info({ telegramId: authedId, gcAmount }, "USDT TON withdrawal rejected: insufficient balance"); await reply(400, { error: "Insufficient balance." }); return; }
    if (e.message === "WEEKLY_CAP_EXCEEDED") { logger.info({ telegramId: authedId, gcAmount, weeklyRemainingGc: e.weeklyRemainingGc ?? 0 }, "USDT TON withdrawal rejected: weekly cap exceeded"); await reply(400, { error: `Weekly withdrawal limit reached. You can withdraw up to $${e.remainingUsd ?? "0.00"} more this week (resets Monday).`, weeklyRemainingGc: e.weeklyRemainingGc ?? 0 }); return; }
    if (e.message === "DAILY_CAP_EXCEEDED") { logger.warn({ telegramId: authedId, gcAmount }, "USDT TON withdrawal rejected: platform daily payout cap exceeded"); await reply(503, { error: "Daily payout limit reached. Please try again tomorrow." }); return; }
    await handle.abort();
    throw err;
  }

  logger.info({ telegramId: authedId, gcAmount, netUsd, weeklyRemainingGc, payoutNetwork: "usdt_ton", walletSuffix: walletAddress.slice(-6), verificationWaivedByVipReferral: hasVipReferralWaiver }, "USDT TON GC withdrawal queued");
  await reply(200, { success: true, gcDeducted: gcAmount, netUsd: parseFloat(netUsd.toFixed(4)), feeUsd: parseFloat((feeGc / gcPerUsd).toFixed(4)), payoutNetwork: "usdt_ton", walletAddress, estimatedTime: isVipUser ? "~4 hours" : "48-72 hours", weeklyRemainingUsd: (weeklyRemainingGc / gcPerUsd).toFixed(2), weeklyRemainingGc, verificationWaivedByVipReferral: hasVipReferralWaiver });
});

export default router;

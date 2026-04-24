import { Router, type IRouter, type Request, type Response } from "express";
import { eq, sql, desc, and, gte, gt } from "drizzle-orm";
import { db, usersTable, withdrawalQueueTable, platformDailyStatsTable, vipTxHashesTable } from "@workspace/db";
import { z } from "zod";
import { serializeRow } from "../lib/serialize";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── Rates & caps ───────────────────────────────────────────────────────────
const FREE_GC_PER_USD = 4000;
const VIP_GC_PER_USD  = 2500;

const FREE_MIN_GC      = 10000;  // $2.50
const VIP_MIN_GC       = 2500;   // $1.00

const FREE_WEEKLY_MAX_USD = 25;   // $25/week
const VIP_WEEKLY_MAX_USD  = 100;  // $100/week

const FEE_PCT = 0.025;  // 2.5% fee

const DAILY_PAYOUT_RATIO = 0.5;
const WITHDRAWAL_COOLDOWN_MS = 3 * 60_000;
const WITHDRAWAL_MAX_24H_COUNT = 6;

// ─── TON verification (verify-fee endpoint) ─────────────────────────────────
const TONAPI_BASE = "https://tonapi.io/v2";
const TON_VERIFY_NANO = BigInt("400000000"); // 0.4 TON ≈ $1.99 verification fee

type TonApiAccount = { address: string };
type TonApiTx = {
  hash: string;
  utime?: number;
  out_msgs: {
    destination?: { address: string };
    value?: number;
    decoded_body?: { text?: string };
    decoded_op_name?: string;
  }[];
};
type TonApiTxList = { transactions: TonApiTx[] };

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, {
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) return { data: null, err: `TON API ${resp.status}` };
    const data = (await resp.json()) as T;
    return { data };
  } catch (e) {
    return { data: null, err: String(e) };
  }
}

async function verifyTonVerificationFee(
  senderAddress: string,
  expectedComment: string,
): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = process.env.KOINARA_TON_WALLET;
  if (!walletEnv) {
    return {
      ok: false,
      err: "TON payment processing is not currently configured. Please contact support.",
      configErr: true,
    };
  }

  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(
    `/accounts/${encodeURIComponent(walletEnv)}`,
  );
  if (!operatorAccount || resolveErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment" };
  }
  const operatorRaw = operatorAccount.address;

  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(
    `/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`,
  );
  if (!txList || txErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment" };
  }

  const minNano = (TON_VERIFY_NANO * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  const RECENCY_WINDOW_SEC = 15 * 60;

  for (const tx of txList.transactions) {
    const ageSec = nowSec - (tx.utime ?? 0);
    if (ageSec > RECENCY_WINDOW_SEC) continue;
    for (const msg of tx.out_msgs) {
      const destRaw = msg.destination?.address ?? "";
      if (destRaw !== operatorRaw) continue;
      const valueNano = BigInt(Math.floor(msg.value ?? 0));
      if (valueNano < minNano) continue;
      // Cryptographic user binding: the tx comment must contain the expected
      // per-user memo. Because the TON tx is signed by the sender, only the
      // sender can include this comment — preventing attackers from hijacking
      // a legitimate payer's on-chain tx to verify their own account.
      const comment = msg.decoded_body?.text ?? "";
      if (comment !== expectedComment) continue;
      return { ok: true, txHash: tx.hash };
    }
  }

  return {
    ok: false,
    err: `No matching verification payment with comment "${expectedComment}" found within the last 15 minutes. Please include the exact comment shown and retry after the transaction confirms.`,
  };
}

// ─── Admin auth helper ───────────────────────────────────────────────────────
function requireAdmin(req: Request, res: Response): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({ error: "Admin endpoints are not configured on this server." });
    return false;
  }
  const authHeader = req.headers.authorization ?? "";
  if (authHeader !== `Bearer ${adminSecret}`) {
    res.status(401).json({ error: "Unauthorized — invalid admin credentials." });
    return false;
  }
  return true;
}

function getWeekStart(): string {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - (day === 0 ? 6 : day - 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().split("T")[0];
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Zod validators ──────────────────────────────────────────────────────────
// TRC-20 addresses: start with "T", 34 chars total, base58 charset
const TRC20_REGEX = /^T[A-Za-z1-9]{33}$/;

const RequestWithdrawalBody = z.object({
  telegramId: z.string(),
  gcAmount: z.number().int().positive(),
  usdtWallet: z.string()
    .min(34, "USDT TRC-20 address must be 34 characters")
    .max(34, "USDT TRC-20 address must be 34 characters")
    .regex(TRC20_REGEX, "Invalid TRC-20 address format. Must start with 'T' and be 34 characters."),
});

const UpdateWithdrawalStatusBody = z.object({
  status: z.enum(["pending", "processing", "complete", "failed"]),
  txHash: z.string().optional(),
});

const VerifyFeeBody = z.object({
  telegramId: z.string(),
  senderAddress: z.string().min(5, "Enter a valid TON wallet address"),
});

// ─── POST /withdrawals/verify-fee ────────────────────────────────────────────
// Verifies the one-time $1.99 identity verification payment on-chain.
// Sets hasVerified=true on the user upon successful TON transaction confirmation.
router.post("/withdrawals/verify-fee", async (req, res): Promise<void> => {
  const body = VerifyFeeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const { telegramId, senderAddress } = body.data;

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.hasVerified) {
    res.json({ success: true, alreadyVerified: true });
    return;
  }

  // Per-user comment binds the on-chain tx to the authenticated Telegram user.
  // Any caller must include this exact text in their TON tx memo.
  const expectedComment = `KNR-VERIFY-${authedId}`;

  const verification = await verifyTonVerificationFee(senderAddress, expectedComment);
  if (verification.configErr) {
    res.status(503).json({ error: verification.err });
    return;
  }
  if (!verification.ok) {
    res.status(400).json({ error: verification.err });
    return;
  }

  // Anti-replay: ensure this tx hash has never been used to verify any user.
  const verifiedTxHash = verification.txHash!;
  const [existingTx] = await db
    .select()
    .from(vipTxHashesTable)
    .where(eq(vipTxHashesTable.txHash, verifiedTxHash))
    .limit(1);

  if (existingTx) {
    logger.warn({ telegramId: authedId, txHash: verifiedTxHash }, "Verification tx hash replay attempt");
    res.status(409).json({ error: "This transaction has already been used for verification. Each payment can only be used once." });
    return;
  }

  // Persist tx hash to prevent replay, then mark user as verified.
  await db.transaction(async (tx) => {
    await tx.insert(vipTxHashesTable).values({
      txHash: verifiedTxHash,
      telegramId,
      plan: "verify_fee",
    });
    await tx
      .update(usersTable)
      .set({ hasVerified: true })
      .where(eq(usersTable.telegramId, telegramId));
  });

  logger.info({ telegramId: authedId, txHash: verifiedTxHash }, "Verification fee accepted");
  res.json({ success: true, alreadyVerified: false });
});

// ─── POST /withdrawals/request ───────────────────────────────────────────────
router.post("/withdrawals/request", async (req, res): Promise<void> => {
  const body = RequestWithdrawalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  const { telegramId, gcAmount, usdtWallet } = body.data;
  const idempotency = await beginIdempotency(req, {
    scope: "withdrawals.request",
    requireHeader: true,
    fingerprintData: {
      telegramId,
      gcAmount,
      usdtWallet,
    },
    ttlMs: 6 * 60 * 60 * 1000,
  });
  if (idempotency.kind === "missing") {
    res.status(400).json({ error: idempotency.message });
    return;
  }
  if (idempotency.kind === "replay") {
    res.status(idempotency.statusCode).json(idempotency.responseBody);
    return;
  }
  if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") {
    res.status(409).json({ error: idempotency.message });
    return;
  }
  if (idempotency.kind !== "acquired") {
    res.status(500).json({ error: "Idempotency precondition failed." });
    return;
  }
  const idempotencyHandle = idempotency;

  const replyWithCommit = async (statusCode: number, payload: unknown): Promise<void> => {
    await idempotencyHandle.commit(statusCode, payload);
    res.status(statusCode).json(payload);
  };

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) {
    await idempotencyHandle.abort();
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    await idempotencyHandle.abort();
    res.status(404).json({ error: "User not found" });
    return;
  }

  const recentThreshold = new Date(Date.now() - WITHDRAWAL_COOLDOWN_MS);
  const [recent] = await db
    .select()
    .from(withdrawalQueueTable)
    .where(
      and(
        eq(withdrawalQueueTable.telegramId, authedId),
        gt(withdrawalQueueTable.createdAt, recentThreshold),
      ),
    )
    .limit(1);
  if (recent) {
    logger.warn({ telegramId: authedId, gcAmount }, "Withdrawal blocked by cooldown guard");
    await replyWithCommit(429, {
      error: "Withdrawal cooldown active. Please wait a few minutes before requesting again.",
      code: "WITHDRAWAL_COOLDOWN",
    });
    return;
  }

  const dayThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const last24hRows = await db
    .select({ id: withdrawalQueueTable.id })
    .from(withdrawalQueueTable)
    .where(
      and(
        eq(withdrawalQueueTable.telegramId, authedId),
        gt(withdrawalQueueTable.createdAt, dayThreshold),
      ),
    );
  if (last24hRows.length >= WITHDRAWAL_MAX_24H_COUNT) {
    logger.warn(
      { telegramId: authedId, last24hCount: last24hRows.length },
      "Withdrawal blocked by daily velocity guard",
    );
    await replyWithCommit(429, {
      error: "Too many withdrawal requests in the last 24 hours. Please try later.",
      code: "WITHDRAWAL_DAILY_VELOCITY",
    });
    return;
  }

  const isVipUser = !!(user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date()) ||
    !!(user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > new Date());

  // Free users must complete one-time identity verification before withdrawing.
  // VIP users are exempt — their TON VIP payment serves as identity verification.
  if (!isVipUser && !user.hasVerified) {
    logger.warn(
      { telegramId: authedId, gcAmount, usdtWalletSuffix: usdtWallet.slice(-6) },
      "Withdrawal blocked: verification required",
    );
    await replyWithCommit(403, {
      error: "Identity verification required. Pay the one-time $1.99 (0.02 TON) verification fee to unlock withdrawals.",
      code: "VERIFICATION_REQUIRED",
    });
    return;
  }

  const gcPerUsd     = isVipUser ? VIP_GC_PER_USD  : FREE_GC_PER_USD;
  const minGc        = isVipUser ? VIP_MIN_GC       : FREE_MIN_GC;
  const weeklyMaxUsd = isVipUser ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;
  const weeklyMaxGc  = weeklyMaxUsd * gcPerUsd;

  if (gcAmount < minGc) {
    const shortfall = minGc - gcAmount;
    await replyWithCommit(400, {
      error: `Minimum withdrawal is ${minGc.toLocaleString()} GC ($${(minGc / gcPerUsd).toFixed(2)}). You need ${shortfall.toLocaleString()} more GC.`,
    });
    return;
  }

  if (user.goldCoins < gcAmount) {
    await replyWithCommit(400, {
      error: `Insufficient balance. You have ${user.goldCoins.toLocaleString()} GC.`,
    });
    return;
  }

  // Compute maxDailyPayoutGc from previous day's revenue (immutable data, safe to read outside tx).
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  const [prevDayStats] = await db
    .select()
    .from(platformDailyStatsTable)
    .where(eq(platformDailyStatsTable.date, yesterdayStr))
    .limit(1);

  // Strict operator safeguard: max daily payouts = 50% of previous day's tracked revenue.
  // When no prior revenue is recorded (e.g. app launch day), the cap is 0 and all
  // withdrawals are blocked until VIP subscriptions / deposits generate revenue.
  const prevRevenueGc = prevDayStats?.totalRevenueGc ?? 0;
  const maxDailyPayoutGc = Math.floor(prevRevenueGc * DAILY_PAYOUT_RATIO);

  const feeGc   = Math.floor(gcAmount * FEE_PCT);
  const netGc   = gcAmount - feeGc;
  const usdValue = gcAmount / gcPerUsd;
  const netUsd   = netGc / gcPerUsd;
  const tier     = isVipUser ? "vip" : "free";
  const weekStart = getWeekStart();

  // ── Atomic transaction with built-in weekly cap enforcement ─────────────────
  // The WHERE clause on the UPDATE includes a cap predicate so concurrent
  // requests cannot both succeed even under READ COMMITTED isolation.
  let weeklyRemainingGc = 0;

  try {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(usersTable)
        .set({
          goldCoins: sql`${usersTable.goldCoins} - ${gcAmount}`,
          weeklyWithdrawnGc: sql`
            CASE
              WHEN ${usersTable.weeklyWithdrawnResetAt} IS NULL
                OR ${usersTable.weeklyWithdrawnResetAt} < ${weekStart}
              THEN ${gcAmount}
              ELSE ${usersTable.weeklyWithdrawnGc} + ${gcAmount}
            END`,
          weeklyWithdrawnResetAt: weekStart,
        })
        .where(and(
          eq(usersTable.telegramId, telegramId),
          // Balance must still cover the request
          gte(usersTable.goldCoins, gcAmount),
          // Atomic weekly cap: new weekly total must not exceed the limit
          sql`(
            CASE
              WHEN ${usersTable.weeklyWithdrawnResetAt} IS NULL
                OR ${usersTable.weeklyWithdrawnResetAt} < ${weekStart}
              THEN ${gcAmount}
              ELSE ${usersTable.weeklyWithdrawnGc} + ${gcAmount}
            END
          ) <= ${weeklyMaxGc}`,
        ))
        .returning();

      if (updated.length === 0) {
        // Either balance too low or weekly cap exceeded — determine which
        const [fresh] = await tx
          .select()
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .limit(1);

        if (!fresh || fresh.goldCoins < gcAmount) {
          throw new Error("INSUFFICIENT_BALANCE");
        }
        // Cap must have been exceeded
        const freshWeekly = (!fresh.weeklyWithdrawnResetAt || fresh.weeklyWithdrawnResetAt < weekStart)
          ? 0
          : (fresh.weeklyWithdrawnGc ?? 0);
        const remaining = Math.max(0, weeklyMaxGc - freshWeekly);
        const remainingUsd = (remaining / gcPerUsd).toFixed(2);
        throw Object.assign(new Error("WEEKLY_CAP_EXCEEDED"), { weeklyRemainingGc: remaining, remainingUsd });
      }

      // Compute weekly remaining from the updated row
      const updatedRow = updated[0]!;
      weeklyRemainingGc = Math.max(0, weeklyMaxGc - (updatedRow.weeklyWithdrawnGc ?? gcAmount));

      // Atomically enforce daily payout cap inside the transaction.
      // 1) Ensure a stats row exists for today (no-op if already there).
      await tx
        .insert(platformDailyStatsTable)
        .values({ date: todayStr(), totalPaidOutGc: 0 })
        .onConflictDoNothing();

      // 2) Increment paidOutGc ONLY if cap is not exceeded. Returning 0 rows = cap hit.
      const [dailyUpdated] = await tx
        .update(platformDailyStatsTable)
        .set({ totalPaidOutGc: sql`${platformDailyStatsTable.totalPaidOutGc} + ${gcAmount}` })
        .where(and(
          eq(platformDailyStatsTable.date, todayStr()),
          sql`${platformDailyStatsTable.totalPaidOutGc} + ${gcAmount} <= ${maxDailyPayoutGc}`,
        ))
        .returning();

      if (!dailyUpdated) {
        throw new Error("DAILY_CAP_EXCEEDED");
      }

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
    });
  } catch (err: unknown) {
    const e = err as Error & { weeklyRemainingGc?: number; remainingUsd?: string };
    if (e.message === "INSUFFICIENT_BALANCE") {
      logger.info({ telegramId: authedId, gcAmount }, "Withdrawal rejected: insufficient balance");
      await replyWithCommit(400, { error: "Insufficient balance." });
      return;
    }
    if (e.message === "WEEKLY_CAP_EXCEEDED") {
      logger.info(
        { telegramId: authedId, gcAmount, weeklyRemainingGc: e.weeklyRemainingGc ?? 0 },
        "Withdrawal rejected: weekly cap exceeded",
      );
      await replyWithCommit(400, {
        error: `Weekly withdrawal limit reached. You can withdraw up to $${e.remainingUsd ?? "0.00"} more this week (resets Monday).`,
        weeklyRemainingGc: e.weeklyRemainingGc ?? 0,
      });
      return;
    }
    if (e.message === "DAILY_CAP_EXCEEDED") {
      logger.warn({ telegramId: authedId, gcAmount }, "Withdrawal rejected: platform daily payout cap exceeded");
      await replyWithCommit(503, {
        error: "Daily payout limit reached. Please try again tomorrow.",
      });
      return;
    }
    await idempotencyHandle.abort();
    throw err;
  }

  const [updated] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  logger.info(
    {
      telegramId: authedId,
      gcAmount,
      feeGc,
      netUsd: Number(netUsd.toFixed(4)),
      weeklyRemainingGc,
      tier,
    },
    "Withdrawal queued successfully",
  );

  await replyWithCommit(200, {
    success: true,
    gcDeducted: gcAmount,
    netUsd: parseFloat(netUsd.toFixed(4)),
    feeUsd: parseFloat((feeGc / gcPerUsd).toFixed(4)),
    estimatedTime: isVipUser ? "~4 hours" : "48–72 hours",
    weeklyRemainingUsd: (weeklyRemainingGc / gcPerUsd).toFixed(2),
    weeklyRemainingGc,
    newGcBalance: updated?.goldCoins ?? 0,
  });
});

// ─── GET /withdrawals/:telegramId ─────────────────────────────────────────────
// Returns only the requesting user's withdrawal history.
router.get("/withdrawals/:telegramId", async (req, res): Promise<void> => {
  const telegramId = req.params.telegramId;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const rows = await db
    .select()
    .from(withdrawalQueueTable)
    .where(eq(withdrawalQueueTable.telegramId, authedId))
    .orderBy(desc(withdrawalQueueTable.createdAt))
    .limit(50);

  const weekStart = getWeekStart();
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const isVipUser = !!(user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date()) ||
    !!(user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > new Date());

  const gcPerUsd     = isVipUser ? VIP_GC_PER_USD  : FREE_GC_PER_USD;
  const weeklyMaxUsd = isVipUser ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;
  const weeklyMaxGc  = weeklyMaxUsd * gcPerUsd;

  const freshWeekly = (!user.weeklyWithdrawnResetAt || user.weeklyWithdrawnResetAt < weekStart)
    ? 0
    : (user.weeklyWithdrawnGc ?? 0);
  const weeklyRemainingGc = Math.max(0, weeklyMaxGc - freshWeekly);

  res.json({
    withdrawals: rows.map(r => serializeRow(r as Record<string, unknown>)),
    weeklyRemainingGc,
    weeklyMaxGc,
    weeklyUsedGc: freshWeekly,
    hasVerified: user.hasVerified ?? false,
  });
});

// ─── PATCH /withdrawals/:id/status  (admin-only) ─────────────────────────────
router.patch("/withdrawals/:id/status", async (req, res): Promise<void> => {
  // This endpoint mutates payout records — it requires admin authorization.
  if (!requireAdmin(req, res)) return;

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

  // Atomic: only update rows that haven't already been completed/failed.
  // This prevents accidental double-approvals or re-opening completed withdrawals.
  const updateData: Record<string, unknown> = { status };
  if (txHash) updateData.txHash = txHash;
  if (status === "complete" || status === "processing") {
    updateData.processesAt = new Date();
  }

  const [updated] = await db
    .update(withdrawalQueueTable)
    .set(updateData)
    .where(and(
      eq(withdrawalQueueTable.id, id),
      // Only allow transitions from non-terminal states
      sql`${withdrawalQueueTable.status} NOT IN ('complete', 'failed')`,
    ))
    .returning();

  if (!updated) {
    // Check if the row exists at all
    const [existing] = await db
      .select()
      .from(withdrawalQueueTable)
      .where(eq(withdrawalQueueTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Withdrawal not found" });
      return;
    }
    // Row exists but is in a terminal state
    res.status(409).json({
      error: `Cannot update a withdrawal that is already ${existing.status}.`,
      currentStatus: existing.status,
    });
    return;
  }

  logger.info(
    {
      withdrawalId: updated.id,
      telegramId: updated.telegramId,
      statusFrom: "non-terminal",
      statusTo: updated.status,
      txHash: updated.txHash ?? null,
    },
    "Withdrawal status updated",
  );
  res.json(serializeRow(updated as Record<string, unknown>));
});

export default router;

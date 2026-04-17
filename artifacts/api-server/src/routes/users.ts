import { Router, type IRouter } from "express";
import { eq, count, sql, desc } from "drizzle-orm";
import { db, usersTable, predictionsTable, vipTxHashesTable, platformDailyStatsTable } from "@workspace/db";
import {
  RegisterUserBody,
  GetUserParams,
  GetUserResponse,
  GetUserStatsParams,
  GetUserStatsResponse,
  UpdateWalletParams,
  UpdateWalletBody,
  UpdateWalletResponse,
  UpgradeToVipParams,
  UpgradeToVipBody,
  UpgradeToVipResponse,
  RegisterUserResponse,
  ActivateVipTrialParams,
  ActivateVipTrialBody,
} from "@workspace/api-zod";
import { serializeRow } from "../lib/serialize";

const router: IRouter = Router();

// Read lazily so tests can set/unset the env var at runtime.
const getKoinaraWallet = () => process.env.KOINARA_TON_WALLET;
const TON_WEEKLY_NANO = BigInt("500000000");   // 0.5 TON in nanotons
const TON_MONTHLY_NANO = BigInt("1500000000"); // 1.5 TON in nanotons
const TONAPI_BASE = "https://tonapi.io/v2";

type TonApiAccount = { address: string };
type TonApiTx = {
  hash: string;
  utime: number;
  out_msgs: Array<{
    destination?: { address?: string };
    value?: number;
  }>;
};
type TonApiTxList = { transactions: TonApiTx[] };

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch {
    return { data: null, err: "TON API unreachable" };
  }
}

/**
 * Verify a VIP TON payment by inspecting the sender's recent on-chain transactions.
 *
 * Strategy:
 * 1. Resolve our operator wallet to its canonical raw address (0:hex) via tonapi.
 * 2. Fetch the last 10 outgoing transactions from the user's wallet.
 * 3. Find one where out_msgs destination matches operator raw address and
 *    value meets the 95%-of-expected threshold.
 * 4. Return the on-chain tx hash for idempotency (dedup in vip_tx_hashes).
 *
 * Fail-closed: returns configErr=true (→ 503) when KOINARA_TON_WALLET is unset.
 */
async function verifyTonTransaction(
  senderAddress: string,
  plan: "weekly" | "monthly",
): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = getKoinaraWallet();
  if (!walletEnv) {
    // Fail-closed: never silently approve a payment when the operator wallet is not configured.
    // In production set KOINARA_TON_WALLET to the operator TON address to enable TON VIP payments.
    console.error("[VIP] KOINARA_TON_WALLET is not set — TON payment processing is disabled");
    return {
      ok: false,
      err: "TON payment processing is not currently configured. Please contact support.",
      configErr: true,
    };
  }

  // Step 1: Resolve operator wallet to canonical raw address
  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(
    `/accounts/${encodeURIComponent(walletEnv)}`,
  );
  if (!operatorAccount || resolveErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment" };
  }
  const operatorRaw = operatorAccount.address; // e.g. "0:abc123..."

  // Step 2: Fetch sender's recent outgoing transactions (limit=50 for active wallets)
  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(
    `/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`,
  );
  if (!txList || txErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment" };
  }

  // Step 3: Find a matching transaction within the recency window.
  // Only accept transactions confirmed within the last 15 minutes to prevent
  // a user reusing an old payment or scanning stale tx history.
  const expectedNano = plan === "weekly" ? TON_WEEKLY_NANO : TON_MONTHLY_NANO;
  const minNano = (expectedNano * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  const RECENCY_WINDOW_SEC = 15 * 60; // 15 minutes

  for (const tx of txList.transactions) {
    const ageSec = nowSec - (tx.utime ?? 0);
    if (ageSec > RECENCY_WINDOW_SEC) continue; // skip transactions older than 15 min
    for (const msg of tx.out_msgs) {
      const destRaw = msg.destination?.address ?? "";
      if (destRaw !== operatorRaw) continue;
      const valueNano = BigInt(Math.floor(msg.value ?? 0));
      if (valueNano >= minNano) {
        return { ok: true, txHash: tx.hash };
      }
    }
  }

  return {
    ok: false,
    err: "No matching TON payment found within the last 15 minutes. Please ensure the transaction is confirmed and try again.",
  };
}

const USER_SCHEMA = (row: Record<string, unknown>) =>
  RegisterUserResponse.parse(serializeRow(row));

router.post("/users/register", async (req, res): Promise<void> => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, username, firstName, lastName, photoUrl, referredBy } = parsed.data;
  const today = new Date().toISOString().split("T")[0];

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (existing.length > 0) {
    const existingUser = existing[0];
    const updateData: Record<string, unknown> = { username, firstName, lastName, photoUrl };

    // Day-7 survivor bonus: +3000 TC awarded once using a dedicated flag (day7BonusClaimed)
    // so it fires regardless of whether the user already used a VIP trial via another path.
    // The 24h trial portion still respects hadVipTrial (one lifetime trial only).
    if (existingUser.registrationDate && !existingUser.day7BonusClaimed) {
      const regDate = new Date(existingUser.registrationDate);
      const daysSinceReg = (Date.now() - regDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceReg >= 7) {
        updateData.day7BonusClaimed = true;
        updateData.tradeCredits = sql`${usersTable.tradeCredits} + 3000`;
        // Only grant the trial if they haven't had one yet
        if (!existingUser.hadVipTrial) {
          const trialExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
          updateData.vipTrialExpiresAt = trialExpiry;
          updateData.hadVipTrial = true;
        }
      }
    }

    const [updated] = await db
      .update(usersTable)
      .set(updateData)
      .where(eq(usersTable.telegramId, telegramId))
      .returning();
    res.json(USER_SCHEMA(updated as Record<string, unknown>));
    return;
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({
      telegramId,
      username,
      firstName,
      lastName,
      photoUrl,
      referredBy: referredBy ?? null,
      tradeCredits: 500,
      goldCoins: 0,
      totalGcEarned: 0,
      registrationDate: today,
    })
    .returning();

  // Referral reward: credit referrer with 200 TC when a new user joins via their link
  if (referredBy) {
    await db
      .update(usersTable)
      .set({ tradeCredits: sql`${usersTable.tradeCredits} + 200` })
      .where(eq(usersTable.telegramId, referredBy));
  }

  res.status(200).json(USER_SCHEMA(newUser as Record<string, unknown>));
});

router.get("/users/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(GetUserResponse.parse(serializeRow(user as Record<string, unknown>)));
});

router.get("/users/:telegramId/stats", async (req, res): Promise<void> => {
  const params = GetUserStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { telegramId } = params.data;

  const preds = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.telegramId, telegramId));

  const resolved = preds.filter((p) => p.status !== "pending");
  const wins = resolved.filter((p) => p.status === "won").length;
  const losses = resolved.filter((p) => p.status === "lost").length;
  const totalTcWagered = preds.reduce((acc, p) => acc + p.amount, 0);
  const totalGcEarned = resolved
    .filter((p) => p.status === "won")
    .reduce((acc, p) => acc + (p.payout ?? 0), 0);
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;

  const referralCountResult = await db
    .select({ cnt: count() })
    .from(usersTable)
    .where(eq(usersTable.referredBy, telegramId));
  const referralCount = referralCountResult[0]?.cnt ?? 0;

  const allUsers = await db
    .select({ telegramId: usersTable.telegramId, totalGcEarned: usersTable.totalGcEarned })
    .from(usersTable)
    .orderBy(desc(usersTable.totalGcEarned));

  const rankIndex = allUsers.findIndex((u) => u.telegramId === telegramId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : allUsers.length + 1;

  res.json(GetUserStatsResponse.parse({
    totalPredictions: preds.length,
    wins,
    losses,
    winRate,
    totalTcWagered,
    totalGcEarned,
    referralCount: Number(referralCount),
    rank,
  }));
});

router.patch("/users/:telegramId/wallet", async (req, res): Promise<void> => {
  const params = UpdateWalletParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateWalletBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ walletAddress: body.data.walletAddress })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateWalletResponse.parse(serializeRow(updated as Record<string, unknown>)));
});

router.post("/users/:telegramId/vip/subscribe", async (req, res): Promise<void> => {
  const params = UpgradeToVipParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpgradeToVipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const { plan, senderAddress } = body.data;
  const now = new Date();

  // Idempotency: if user is already VIP and it hasn't expired, return current state
  if (user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now) {
    res.json(UpgradeToVipResponse.parse(serializeRow(user as Record<string, unknown>)));
    return;
  }

  if (plan === "weekly" || plan === "monthly") {
    if (!senderAddress) {
      res.status(400).json({ error: "senderAddress required for TON plans" });
      return;
    }

    // Wallet binding enforcement: require a TON wallet to be connected before paying.
    // If no wallet is bound, reject — this prevents claiming VIP using another user's tx.
    if (!user.walletAddress) {
      res.status(400).json({ error: "Please connect your TON wallet first before subscribing." });
      return;
    }
    // Cryptographic binding: the senderAddress must exactly match the connected wallet.
    // Case-insensitive compare handles TON address format variants.
    if (user.walletAddress.toLowerCase() !== senderAddress.toLowerCase()) {
      res.status(403).json({ error: "Sender address does not match your connected wallet. Please reconnect your wallet and try again." });
      return;
    }

    const durationDays = plan === "weekly" ? 7 : 30;
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const vipPlan = plan === "weekly" ? "ton_weekly" : "ton_monthly";

    // On-chain verification: resolves operator wallet to raw address, scans sender's
    // recent transactions for a matching payment, returns the on-chain tx hash.
    const verification = await verifyTonTransaction(senderAddress, plan);
    if (!verification.ok) {
      const statusCode = verification.configErr ? 503 : 422;
      res.status(statusCode).json({ error: verification.err ?? "TON transaction verification failed" });
      return;
    }

    // Deduplication using the on-chain tx hash returned by verifyTonTransaction.
    const verifiedTxHash = verification.txHash;
    if (verifiedTxHash) {
      const [existingTx] = await db
        .select()
        .from(vipTxHashesTable)
        .where(eq(vipTxHashesTable.txHash, verifiedTxHash))
        .limit(1);
      if (existingTx) {
        res.status(409).json({ error: "This transaction has already been used. Please contact support if this is an error." });
        return;
      }

      await db.insert(vipTxHashesTable).values({
        txHash: verifiedTxHash,
        telegramId: params.data.telegramId,
        plan: vipPlan,
      });
    }

    const [updated] = await db
      .update(usersTable)
      .set({ isVip: true, vipPlan, vipExpiresAt: expiresAt })
      .where(eq(usersTable.telegramId, params.data.telegramId))
      .returning();

    // Track VIP subscription revenue for the daily payout cap.
    // Approximate GC equivalent: weekly=$2→5000 GC, monthly=$6→15000 GC (at 2500 GC/$1 VIP rate).
    const vipRevenueGc = vipPlan === "ton_monthly" ? 15000 : 5000;
    const todayDate = new Date().toISOString().split("T")[0];
    await db
      .insert(platformDailyStatsTable)
      .values({ date: todayDate, totalRevenueGc: vipRevenueGc })
      .onConflictDoUpdate({
        target: platformDailyStatsTable.date,
        set: { totalRevenueGc: sql`platform_daily_stats.total_revenue_gc + ${vipRevenueGc}` },
      });

    // Referral reward: when a referred user purchases a paid VIP plan, notify the referrer
    // by setting referralVipRewardPending=true. The referrer's client polls user state and
    // triggers a free 24h VIP trial for the referrer as a thank-you.
    if (user.referredBy) {
      await db
        .update(usersTable)
        .set({ referralVipRewardPending: true })
        .where(eq(usersTable.telegramId, user.referredBy));
    }

    res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
    return;
  }

  if (plan === "tc") {
    const TC_FEE = 500;
    if (user.tradeCredits < TC_FEE) {
      res.status(400).json({ error: `Need ${TC_FEE} Trade Credits to activate VIP.` });
      return;
    }
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [updated] = await db
      .update(usersTable)
      .set({
        isVip: true,
        vipPlan: "tc_weekly",
        vipExpiresAt: expiresAt,
        tradeCredits: sql`${usersTable.tradeCredits} - ${TC_FEE}`,
      })
      .where(eq(usersTable.telegramId, params.data.telegramId))
      .returning();

    // TC plan also triggers referral reward for the referrer
    if (user.referredBy) {
      await db
        .update(usersTable)
        .set({ referralVipRewardPending: true })
        .where(eq(usersTable.telegramId, user.referredBy));
    }

    res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
    return;
  }

  // Fallback — only plan="tc" should reach here after weekly/monthly are blocked above
  res.status(400).json({ error: "Invalid plan type" });
});

router.post("/users/:telegramId/activate-trial", async (req, res): Promise<void> => {
  const params = ActivateVipTrialParams.safeParse(req.params);
  const body = ActivateVipTrialBody.safeParse(req.body);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const now = new Date();

  const hasActivePaidVip = user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now;
  if (hasActivePaidVip) {
    res.status(400).json({ error: "Already on a paid VIP plan" });
    return;
  }

  // One-time lifetime check — hadVipTrial is set to true permanently on first activation
  if (user.hadVipTrial) {
    res.status(400).json({ error: "VIP trial already used" });
    return;
  }

  const { reason } = body.data;

  // Server-side eligibility enforcement per reason.
  // The client is untrusted; each trigger condition is re-verified against DB state.
  if (reason === "tc_zero") {
    if (user.tradeCredits !== 0) {
      res.status(403).json({ error: "Eligibility condition not met: tradeCredits must be 0" });
      return;
    }
  } else if (reason === "gc_milestone") {
    if (user.goldCoins < 5000) {
      res.status(403).json({ error: "Eligibility condition not met: goldCoins must be >= 5000" });
      return;
    }
    if (user.gcMilestoneTrialClaimed) {
      res.status(409).json({ error: "GC milestone trial already claimed" });
      return;
    }
  } else if (reason === "referral") {
    if (!user.referralVipRewardPending) {
      res.status(403).json({ error: "Eligibility condition not met: no pending referral reward" });
      return;
    }
  }

  const trialExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Atomically apply the trial + clear/set any trigger flags in a single UPDATE.
  // Always clear referralVipRewardPending regardless of reason — a trial is a single
  // consumption event; if the user earned it via tc_zero or gc_milestone but also has
  // a pending referral reward, clear it so it cannot be claimed separately later.
  const flagUpdates = {
    referralVipRewardPending: false,
    ...(reason === "gc_milestone" ? { gcMilestoneTrialClaimed: true } : {}),
  };

  const [updated] = await db
    .update(usersTable)
    .set({ vipTrialExpiresAt: trialExpiresAt, hadVipTrial: true, ...flagUpdates })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  res.json(USER_SCHEMA(updated as Record<string, unknown>));
});

router.get("/users/:telegramId/referrals", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const [user] = await db
    .select({
      telegramId: usersTable.telegramId,
      referralEarnings: usersTable.referralEarnings,
      referralEarningsUnlockedAt: usersTable.referralEarningsUnlockedAt,
    })
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const referralCountResult = await db
    .select({ cnt: count() })
    .from(usersTable)
    .where(eq(usersTable.referredBy, telegramId));
  const referralCount = Number(referralCountResult[0]?.cnt ?? 0);

  const now = new Date();
  const isUnlocked =
    user.referralEarningsUnlockedAt != null &&
    new Date(user.referralEarningsUnlockedAt) <= now;

  res.json({
    referralCount,
    pendingGc: user.referralEarnings ?? 0,
    isUnlocked,
    unlocksAt: user.referralEarningsUnlockedAt
      ? new Date(user.referralEarningsUnlockedAt).toISOString()
      : null,
  });
});

export default router;

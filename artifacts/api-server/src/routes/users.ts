import { Router, type IRouter } from "express";
import { eq, count, sql, desc } from "drizzle-orm";
import { db, usersTable, predictionsTable, vipTxHashesTable, platformDailyStatsTable, betaWaitlistTable } from "@workspace/db";
import { isPaymentTxHashUsed } from "../lib/paymentTxGuard";
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
} from "@workspace/api-zod";
import { serializeRow } from "../lib/serialize";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { processCommission } from "./commissions";

const router: IRouter = Router();

const getKoinaraWallet = () => process.env.KOINARA_TON_WALLET;
const TON_MONTHLY_NANO = BigInt("1700000000");
const TONAPI_BASE = "https://tonapi.io/v2";
const BETA_LOCK_ID = 500_500_500;

type TonApiAccount = { address: string };
type TonApiTx = { hash: string; utime: number; out_msgs: Array<{ destination?: { address?: string }; value?: number; decoded_body?: { text?: string } }> };
type TonApiTxList = { transactions: TonApiTx[] };

type BetaWaitlistResponse = {
  betaLocked: true;
  betaGateEnabled: true;
  betaLimit: number;
  waitlistPosition: number;
  message: string;
};

function vipMemo(telegramId: string, plan: "monthly"): string { return `KNR-VIP-${plan}-${telegramId}`; }

function betaGateEnabled(): boolean {
  const raw = (process.env.BETA_GATE_ENABLED ?? "true").toLowerCase().trim();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function betaLimit(): number {
  const parsed = Number(process.env.BETA_USER_LIMIT ?? "500");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 500;
}

function ownerTelegramId(): string | null {
  return process.env.OWNER_TELEGRAM_ID?.trim() || null;
}

function withBetaFields(row: Record<string, unknown>): Record<string, unknown> {
  const parsed = RegisterUserResponse.parse(serializeRow(row));
  return {
    ...parsed,
    betaAccessGranted: row.betaAccessGranted ?? row.beta_access_granted ?? true,
    betaNumber: row.betaNumber ?? row.beta_number ?? row.id ?? null,
    betaAccessGrantedAt: row.betaAccessGrantedAt ?? row.beta_access_granted_at ?? row.createdAt ?? row.created_at ?? null,
    betaGateEnabled: betaGateEnabled(),
    betaLimit: betaLimit(),
  };
}

async function ensureBetaGateSchema(): Promise<void> {
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_access_granted BOOLEAN NOT NULL DEFAULT TRUE`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_number INTEGER`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS beta_waitlist (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL UNIQUE,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      photo_url TEXT,
      source TEXT,
      position INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS beta_waitlist_telegram_id_idx ON beta_waitlist (telegram_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS beta_waitlist_created_at_idx ON beta_waitlist (created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS beta_waitlist_source_idx ON beta_waitlist (source)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS users_beta_access_granted_idx ON users (beta_access_granted)`);
}

async function createUserOrWaitlist(input: {
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
  referredBy?: string | null;
  registrationDate: string;
}): Promise<{ user?: Record<string, unknown>; waitlist?: BetaWaitlistResponse }> {
  await ensureBetaGateSchema();

  if (!betaGateEnabled()) {
    const [newUser] = await db.insert(usersTable).values({
      telegramId: input.telegramId,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
      photoUrl: input.photoUrl,
      referredBy: input.referredBy ?? null,
      tradeCredits: 500,
      goldCoins: 0,
      totalGcEarned: 0,
      registrationDate: input.registrationDate,
      betaAccessGranted: true,
      betaNumber: null,
      betaAccessGrantedAt: new Date(),
    }).returning();
    return { user: newUser as Record<string, unknown> };
  }

  const ownerBypass = ownerTelegramId() === input.telegramId;
  const limit = betaLimit();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BETA_LOCK_ID})`);
    const acceptedRows = await tx.select({ cnt: count() }).from(usersTable).where(eq(usersTable.betaAccessGranted, true));
    const acceptedCount = Number(acceptedRows[0]?.cnt ?? 0);

    if (!ownerBypass && acceptedCount >= limit) {
      const existingWaitlist = await tx.select().from(betaWaitlistTable).where(eq(betaWaitlistTable.telegramId, input.telegramId)).limit(1);
      const waitlistRow = existingWaitlist[0] ?? (await (async () => {
        const rows = await tx.select({ cnt: count() }).from(betaWaitlistTable);
        const position = Number(rows[0]?.cnt ?? 0) + 1;
        const [inserted] = await tx.insert(betaWaitlistTable).values({
          telegramId: input.telegramId,
          username: input.username ?? null,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          photoUrl: input.photoUrl ?? null,
          source: input.referredBy ?? null,
          position,
        }).returning();
        return inserted;
      })());
      return { waitlist: { betaLocked: true, betaGateEnabled: true, betaLimit: limit, waitlistPosition: waitlistRow.position, message: `Koinara Founder Beta is full. You are waitlist #${waitlistRow.position}.` } };
    }

    const betaNumber = acceptedCount + 1;
    const [newUser] = await tx.insert(usersTable).values({
      telegramId: input.telegramId,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
      photoUrl: input.photoUrl,
      referredBy: input.referredBy ?? null,
      tradeCredits: 500,
      goldCoins: 0,
      totalGcEarned: 0,
      registrationDate: input.registrationDate,
      betaAccessGranted: true,
      betaNumber,
      betaAccessGrantedAt: new Date(),
    }).returning();

    return { user: newUser as Record<string, unknown> };
  });
}

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch { return { data: null, err: "TON API unreachable" }; }
}

async function verifyTonTransaction(senderAddress: string, plan: "monthly", expectedMemo: string): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = getKoinaraWallet();
  if (!walletEnv) {
    console.error("[VIP] KOINARA_TON_WALLET is not set — TON payment processing is disabled");
    return { ok: false, err: "TON payment processing is not currently configured. Please contact support.", configErr: true };
  }

  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(`/accounts/${encodeURIComponent(walletEnv)}`);
  if (!operatorAccount || resolveErr) return { ok: false, err: "TON API unreachable — please retry in a moment" };
  const operatorRaw = operatorAccount.address;

  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(`/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`);
  if (!txList || txErr) return { ok: false, err: "TON API unreachable — please retry in a moment" };

  const expectedNano = TON_MONTHLY_NANO;
  const minNano = (expectedNano * 95n) / 100n;
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
      const comment = msg.decoded_body?.text ?? "";
      if (comment !== expectedMemo) continue;
      return { ok: true, txHash: tx.hash };
    }
  }

  return { ok: false, err: `No matching TON payment found within the last 15 minutes. Please include the exact memo/comment "${expectedMemo}" and retry after confirmation.` };
}

const USER_SCHEMA = (row: Record<string, unknown>) => withBetaFields(row);

router.post("/users/register", async (req, res): Promise<void> => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const { username, firstName, lastName, photoUrl, referredBy } = parsed.data;

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const today = new Date().toISOString().split("T")[0];
  await ensureBetaGateSchema();
  const existing = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (existing.length > 0) {
    const existingUser = existing[0];
    const updateData: Record<string, unknown> = { username, firstName, lastName, photoUrl };
    if (existingUser.registrationDate && !existingUser.day7BonusClaimed) {
      const regDate = new Date(existingUser.registrationDate);
      const daysSinceReg = (Date.now() - regDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceReg >= 7) {
        updateData.day7BonusClaimed = true;
        updateData.tradeCredits = sql`${usersTable.tradeCredits} + 3000`;
      }
    }
    const [updated] = await db.update(usersTable).set(updateData).where(eq(usersTable.telegramId, telegramId)).returning();
    res.json(USER_SCHEMA(updated as Record<string, unknown>));
    return;
  }

  const result = await createUserOrWaitlist({ telegramId, username, firstName, lastName, photoUrl, referredBy, registrationDate: today });
  if (result.waitlist) {
    res.status(423).json(result.waitlist);
    return;
  }

  if (referredBy) await db.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + 200` }).where(eq(usersTable.telegramId, referredBy));
  res.status(200).json(USER_SCHEMA(result.user ?? {}));
});

router.get("/users/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const authId = await resolveAuthenticatedTelegramId(req, res, params.data.telegramId);
  if (!authId) return;
  await ensureBetaGateSchema();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(USER_SCHEMA(user as Record<string, unknown>));
});

router.get("/users/:telegramId/stats", async (req, res): Promise<void> => {
  const params = GetUserStatsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const { telegramId } = params.data;
  const authId = await resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authId) return;

  const preds = await db.select().from(predictionsTable).where(eq(predictionsTable.telegramId, authId));
  const resolved = preds.filter((p) => p.status !== "pending");
  const wins = resolved.filter((p) => p.status === "won").length;
  const losses = resolved.filter((p) => p.status === "lost").length;
  const totalTcWagered = preds.reduce((acc, p) => acc + p.amount, 0);
  const totalGcEarned = resolved.filter((p) => p.status === "won").reduce((acc, p) => acc + (p.payout ?? 0), 0);
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;
  const referralCountResult = await db.select({ cnt: count() }).from(usersTable).where(eq(usersTable.referredBy, authId));
  const referralCount = referralCountResult[0]?.cnt ?? 0;
  const allUsers = await db.select({ telegramId: usersTable.telegramId, totalGcEarned: usersTable.totalGcEarned }).from(usersTable).orderBy(desc(usersTable.totalGcEarned));
  const rankIndex = allUsers.findIndex((u) => u.telegramId === authId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : allUsers.length + 1;

  res.json(GetUserStatsResponse.parse({ totalPredictions: preds.length, wins, losses, winRate, totalTcWagered, totalGcEarned, referralCount: Number(referralCount), rank }));
});

router.patch("/users/:telegramId/wallet", async (req, res): Promise<void> => {
  const params = UpdateWalletParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const authId = await resolveAuthenticatedTelegramId(req, res, params.data.telegramId);
  if (!authId) return;
  const body = UpdateWalletBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [updated] = await db.update(usersTable).set({ walletAddress: body.data.walletAddress }).where(eq(usersTable.telegramId, authId)).returning();
  if (!updated) { res.status(404).json({ error: "User not found" }); return; }
  res.json(UpdateWalletResponse.parse(serializeRow(updated as Record<string, unknown>)));
});

router.get("/users/:telegramId/vip/memo", async (req, res): Promise<void> => {
  const params = UpgradeToVipParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const authId = await resolveAuthenticatedTelegramId(req, res, params.data.telegramId);
  if (!authId) return;
  const operatorWallet = getKoinaraWallet();
  if (!operatorWallet) { res.status(503).json({ error: "TON payment wallet is not configured." }); return; }
  res.json({
    plan: "monthly",
    memo: vipMemo(authId, "monthly"),
    operatorWallet,
    amountNano: TON_MONTHLY_NANO.toString(),
  });
});

router.post("/users/:telegramId/vip/subscribe", async (req, res): Promise<void> => {
  const params = UpgradeToVipParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const authId = await resolveAuthenticatedTelegramId(req, res, params.data.telegramId);
  if (!authId) return;
  const body = UpgradeToVipBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const { plan, senderAddress } = body.data;
  const now = new Date();
  if (user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now) { res.json(UpgradeToVipResponse.parse(serializeRow(user as Record<string, unknown>))); return; }

  if (plan === "monthly") {
    if (!senderAddress) { res.status(400).json({ error: "senderAddress required for TON plans" }); return; }
    if (!user.walletAddress) { res.status(400).json({ error: "Please connect your TON wallet first before subscribing." }); return; }
    if (user.walletAddress.toLowerCase() !== senderAddress.toLowerCase()) { res.status(403).json({ error: "Sender address does not match your connected wallet. Please reconnect your wallet and try again." }); return; }

    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const vipPlan = "ton_monthly";
    const expectedMemo = vipMemo(authId, "monthly");
    const verification = await verifyTonTransaction(senderAddress, plan, expectedMemo);
    if (!verification.ok) { res.status(verification.configErr ? 503 : 422).json({ error: verification.err ?? "TON transaction verification failed", requiredMemo: expectedMemo }); return; }

    const verifiedTxHash = verification.txHash;
    if (verifiedTxHash) {
      if (await isPaymentTxHashUsed(verifiedTxHash)) {
        res.status(409).json({ error: "This transaction has already been used for a purchase. Please contact support if this is an error." });
        return;
      }
      await db.insert(vipTxHashesTable).values({ txHash: verifiedTxHash, telegramId: authId, plan: vipPlan });
    }

    const [updated] = await db.update(usersTable).set({
      isVip: true,
      vipPlan,
      vipExpiresAt: expiresAt,
      creatorPassPaid: true,
      creatorPassPaidAt: new Date(),
    }).where(eq(usersTable.telegramId, authId)).returning();

    const vipRevenueGc = 15000;
    const todayDate = new Date().toISOString().split("T")[0];
    await db.insert(platformDailyStatsTable).values({ date: todayDate, totalRevenueGc: vipRevenueGc }).onConflictDoUpdate({ target: platformDailyStatsTable.date, set: { totalRevenueGc: sql`platform_daily_stats.total_revenue_gc + ${vipRevenueGc}` } });

    if (user.referredBy) await db.update(usersTable).set({ referralVipRewardPending: true }).where(eq(usersTable.telegramId, user.referredBy));

    await processCommission({ buyerTelegramId: authId, purchaseType: "vip_purchase", grossUsd: 5.99, isRenewal: false });

    res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
    return;
  }

  if (plan === "tc") { res.status(400).json({ error: "TC-based VIP plan has been removed. Please use weekly/monthly TON plans." }); return; }
  res.status(400).json({ error: "Invalid plan type" });
});

router.post("/users/:telegramId/activate-trial", (_req, res): void => {
  res.status(410).json({ error: "Free VIP trials have been removed. Please purchase VIP to activate premium benefits." });
});

router.get("/users/:telegramId/referrals", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) { res.status(400).json({ error: "telegramId required" }); return; }
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const [user] = await db.select({ telegramId: usersTable.telegramId, referralEarnings: usersTable.referralEarnings, referralEarningsUnlockedAt: usersTable.referralEarningsUnlockedAt }).from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const referralCountResult = await db.select({ cnt: count() }).from(usersTable).where(eq(usersTable.referredBy, authedId));
  const referralCount = Number(referralCountResult[0]?.cnt ?? 0);
  const now = new Date();
  const isUnlocked = user.referralEarningsUnlockedAt != null && new Date(user.referralEarningsUnlockedAt) <= now;
  res.json({ referralCount, pendingGc: user.referralEarnings ?? 0, isUnlocked, unlocksAt: user.referralEarningsUnlockedAt ? new Date(user.referralEarningsUnlockedAt).toISOString() : null });
});

router.post("/users/:telegramId/owner-refill-tc", async (req, res): Promise<void> => {
  const ownerEnvId = process.env.OWNER_TELEGRAM_ID;
  if (!ownerEnvId) { res.status(503).json({ error: "Owner tools are not configured on this server." }); return; }
  const { telegramId } = req.params;
  if (telegramId !== ownerEnvId) { res.status(403).json({ error: "Forbidden." }); return; }
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const TC_REFILL = 999_999;
  const [updated] = await db.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${TC_REFILL}` }).where(eq(usersTable.telegramId, authedId)).returning({ newTcBalance: usersTable.tradeCredits });
  if (!updated) { res.status(404).json({ error: "User not found." }); return; }
  res.json({ success: true, tcAdded: TC_REFILL, newTcBalance: updated.newTcBalance });
});

export default router;

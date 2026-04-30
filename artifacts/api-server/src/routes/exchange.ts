import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, tcPackTxHashesTable, platformDailyStatsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { processCommission } from "./commissions";

const router: IRouter = Router();

type TcPack = {
  id: "micro" | "starter" | "pro" | "whale";
  label: string;
  priceTonNano: bigint;
  priceTonLabel: string;
  priceUsdLabel: string;
  tcAwarded: number;
  bonusPct: number;
};

type OvertimePass = {
  id: "trade_overtime";
  label: string;
  priceTonNano: bigint;
  priceTonLabel: string;
  priceUsdLabel: string;
  boostGc: number;
  maxPerDay: number;
};

const TC_PACKS: readonly TcPack[] = [
  { id: "micro", label: "Micro Pack", priceTonNano: 200_000_000n, priceTonLabel: "0.2", priceUsdLabel: "$0.99", tcAwarded: 7_000, bonusPct: 0 },
  { id: "starter", label: "Starter Pack", priceTonNano: 600_000_000n, priceTonLabel: "0.6", priceUsdLabel: "$2.99", tcAwarded: 30_000, bonusPct: 0 },
  { id: "pro", label: "Pro Pack", priceTonNano: 2_000_000_000n, priceTonLabel: "2.0", priceUsdLabel: "$9.99", tcAwarded: 150_000, bonusPct: 0 },
  { id: "whale", label: "Whale Pack", priceTonNano: 10_000_000_000n, priceTonLabel: "10.0", priceUsdLabel: "$49.99", tcAwarded: 1_000_000, bonusPct: 0 },
];

const TRADE_OVERTIME_PASS: OvertimePass = {
  id: "trade_overtime",
  label: "Trade Overtime Pass",
  priceTonNano: 200_000_000n,
  priceTonLabel: "0.2",
  priceUsdLabel: "$0.99",
  boostGc: 3_000,
  maxPerDay: 1,
};

function todayStr(): string { return new Date().toISOString().split("T")[0]; }
function findPack(id: string): TcPack | undefined { return TC_PACKS.find((p) => p.id === id); }
function usdFromLabel(label: string): number { return Number(label.replace(/[^0-9.]/g, "")) || 0; }
function tcPackMemo(telegramId: string, packId: TcPack["id"]): string { return `KNR-PACK-${packId}-${telegramId}`; }
function overtimeMemo(telegramId: string, passId: OvertimePass["id"]): string { return `KNR-OVERTIME-${passId}-${telegramId}`; }

const exchangeRateLimiter = createRouteRateLimiter("exchange-action", { limit: 12, windowMs: 10_000, message: "Too many exchange requests. Slow down and try again." });

router.get("/exchange/tc-packs", (_req, res): void => {
  res.json({ packs: TC_PACKS.map((p) => ({ id: p.id, label: p.label, priceTon: p.priceTonLabel, priceTonNano: p.priceTonNano.toString(), priceUsd: p.priceUsdLabel, tcAwarded: p.tcAwarded, bonusPct: p.bonusPct })) });
});

router.get("/exchange/overtime-passes", (_req, res): void => {
  res.json({ passes: [{ id: TRADE_OVERTIME_PASS.id, label: TRADE_OVERTIME_PASS.label, priceTon: TRADE_OVERTIME_PASS.priceTonLabel, priceTonNano: TRADE_OVERTIME_PASS.priceTonNano.toString(), priceUsd: TRADE_OVERTIME_PASS.priceUsdLabel, boostGc: TRADE_OVERTIME_PASS.boostGc, maxPerDay: TRADE_OVERTIME_PASS.maxPerDay, expires: "UTC daily reset" }] });
});

router.get("/exchange/tc-pack/memo", (req, res): void => {
  const query = z.object({ telegramId: z.string().min(1), packId: z.enum(["micro", "starter", "pro", "whale"]) }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.issues[0]?.message ?? "Invalid query." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, query.data.telegramId);
  if (!telegramId) return;
  const pack = findPack(query.data.packId);
  if (!pack) { res.status(400).json({ error: "Unknown pack." }); return; }
  res.json({ packId: pack.id, memo: tcPackMemo(telegramId, pack.id) });
});

router.get("/exchange/overtime-pass/memo", (req, res): void => {
  const query = z.object({ telegramId: z.string().min(1), passId: z.literal("trade_overtime") }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: query.error.issues[0]?.message ?? "Invalid query." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, query.data.telegramId);
  if (!telegramId) return;
  res.json({ passId: TRADE_OVERTIME_PASS.id, memo: overtimeMemo(telegramId, TRADE_OVERTIME_PASS.id) });
});

const TcPackPurchaseBody = z.object({ telegramId: z.string().min(1), packId: z.enum(["micro", "starter", "pro", "whale"]), senderAddress: z.string().min(1) });
const OvertimePassPurchaseBody = z.object({ telegramId: z.string().min(1), passId: z.literal("trade_overtime"), senderAddress: z.string().min(1) });

const getOperatorWallet = () => process.env.KOINARA_TON_WALLET;
const TONAPI_BASE = "https://tonapi.io/v2";
type TonApiAccount = { address: string };
type TonApiTx = { hash: string; utime: number; out_msgs: Array<{ destination?: { address?: string }; value?: number; decoded_body?: { text?: string }; decoded_op_name?: string }> };
type TonApiTxList = { transactions: TonApiTx[] };

async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch { return { data: null, err: "TON API unreachable" }; }
}

async function verifyTonPayment(senderAddress: string, expectedNano: bigint, expectedMemo: string): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = getOperatorWallet();
  if (!walletEnv) { logger.error("[EXCHANGE] KOINARA_TON_WALLET is not set — TON payment processing disabled"); return { ok: false, err: "TON payment processing is not configured. Please contact support.", configErr: true }; }
  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(`/accounts/${encodeURIComponent(walletEnv)}`);
  if (!operatorAccount || resolveErr) return { ok: false, err: "TON API unreachable — please retry in a moment." };
  const operatorRaw = operatorAccount.address;
  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(`/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`);
  if (!txList || txErr) return { ok: false, err: "TON API unreachable — please retry in a moment." };
  const minNano = (expectedNano * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const tx of txList.transactions) {
    if (nowSec - (tx.utime ?? 0) > 15 * 60) continue;
    for (const msg of tx.out_msgs) {
      if ((msg.destination?.address ?? "") !== operatorRaw) continue;
      if (BigInt(Math.floor(msg.value ?? 0)) < minNano) continue;
      if ((msg.decoded_body?.text ?? "") !== expectedMemo) continue;
      return { ok: true, txHash: tx.hash };
    }
  }
  return { ok: false, err: `No matching TON payment found within the last 15 minutes. Please include the exact memo/comment "${expectedMemo}" and retry after confirmation.` };
}

router.post("/exchange/tc-pack/purchase", exchangeRateLimiter, async (req, res): Promise<void> => {
  const parsed = TcPackPurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { packId, senderAddress } = parsed.data;
  const pack = findPack(packId);
  if (!pack) { res.status(400).json({ error: "Unknown pack." }); return; }

  const expectedMemo = tcPackMemo(telegramId, pack.id);
  const verification = await verifyTonPayment(senderAddress, pack.priceTonNano, expectedMemo);
  if (!verification.ok) { res.status(verification.configErr ? 503 : 400).json({ error: verification.err ?? "TON payment verification failed.", requiredMemo: expectedMemo }); return; }
  const txHash = verification.txHash;
  if (!txHash) { res.status(500).json({ error: "TON verifier returned no tx hash." }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      try { await tx.insert(tcPackTxHashesTable).values({ txHash, telegramId, pack: pack.id, tcAwarded: pack.tcAwarded }); }
      catch (err) { const msg = err instanceof Error ? err.message : ""; if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) throw new Error("TX_ALREADY_USED"); throw err; }
      await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${pack.tcAwarded}` }).where(eq(usersTable.telegramId, telegramId));
      const todayDate = todayStr();
      const packRevenueGc = Math.floor(Number(pack.priceTonNano) / 1e9 * 2500);
      await tx.insert(platformDailyStatsTable).values({ date: todayDate, totalRevenueGc: packRevenueGc }).onConflictDoUpdate({ target: platformDailyStatsTable.date, set: { totalRevenueGc: sql`platform_daily_stats.total_revenue_gc + ${packRevenueGc}` } });
      const [updated] = await tx.select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins }).from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
      return updated;
    });

    await processCommission({ buyerTelegramId: telegramId, purchaseType: "tc_pack", grossUsd: usdFromLabel(pack.priceUsdLabel), isRenewal: false });

    logger.info({ telegramId, pack: pack.id, tcAwarded: pack.tcAwarded, txHash }, "TC pack purchased");
    res.status(200).json({ pack: pack.id, tcAwarded: pack.tcAwarded, txHash, balances: { goldCoins: result?.goldCoins ?? 0, tradeCredits: result?.tradeCredits ?? 0 } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "TX_ALREADY_USED") { res.status(409).json({ error: "This TON payment has already been credited. If your TC balance looks wrong, contact support." }); return; }
    logger.error({ err, telegramId, pack: pack.id, txHash }, "TC pack purchase failed");
    res.status(500).json({ error: "TC pack credit failed. Please contact support." });
  }
});

router.post("/exchange/overtime-pass/purchase", exchangeRateLimiter, async (req, res): Promise<void> => {
  const parsed = OvertimePassPurchaseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { senderAddress } = parsed.data;
  const today = todayStr();
  const expectedMemo = overtimeMemo(telegramId, TRADE_OVERTIME_PASS.id);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const alreadyBoostedToday = user.dailyTradeCapBoostDate === today && (user.dailyTradeCapBoostGc ?? 0) >= TRADE_OVERTIME_PASS.boostGc;
  if (alreadyBoostedToday) { res.status(409).json({ error: "Trade Overtime Pass already used today. It resets at UTC daily reset." }); return; }
  const verification = await verifyTonPayment(senderAddress, TRADE_OVERTIME_PASS.priceTonNano, expectedMemo);
  if (!verification.ok) { res.status(verification.configErr ? 503 : 400).json({ error: verification.err ?? "TON payment verification failed.", requiredMemo: expectedMemo }); return; }
  const txHash = verification.txHash;
  if (!txHash) { res.status(500).json({ error: "TON verifier returned no tx hash." }); return; }
  try {
    const result = await db.transaction(async (tx) => {
      try { await tx.insert(tcPackTxHashesTable).values({ txHash, telegramId, pack: TRADE_OVERTIME_PASS.id, tcAwarded: 0 }); }
      catch (err) { const msg = err instanceof Error ? err.message : ""; if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) throw new Error("TX_ALREADY_USED"); throw err; }
      const [updated] = await tx.update(usersTable).set({ dailyTradeCapBoostGc: TRADE_OVERTIME_PASS.boostGc, dailyTradeCapBoostDate: today }).where(eq(usersTable.telegramId, telegramId)).returning({ dailyTradeCapBoostGc: usersTable.dailyTradeCapBoostGc, dailyTradeCapBoostDate: usersTable.dailyTradeCapBoostDate, dailyGcEarned: usersTable.dailyGcEarned, dailyGcDate: usersTable.dailyGcDate });
      const revenueGc = Math.floor(Number(TRADE_OVERTIME_PASS.priceTonNano) / 1e9 * 2500);
      await tx.insert(platformDailyStatsTable).values({ date: today, totalRevenueGc: revenueGc }).onConflictDoUpdate({ target: platformDailyStatsTable.date, set: { totalRevenueGc: sql`platform_daily_stats.total_revenue_gc + ${revenueGc}` } });
      return updated;
    });
    logger.info({ telegramId, txHash, boostGc: TRADE_OVERTIME_PASS.boostGc }, "Trade Overtime Pass purchased");
    res.status(200).json({ passId: TRADE_OVERTIME_PASS.id, boostGc: TRADE_OVERTIME_PASS.boostGc, date: today, txHash, tradeCap: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "TX_ALREADY_USED") { res.status(409).json({ error: "This TON payment has already been credited. If your cap boost looks wrong, contact support." }); return; }
    logger.error({ err, telegramId, txHash }, "Trade Overtime Pass purchase failed");
    res.status(500).json({ error: "Trade Overtime Pass credit failed. Please contact support." });
  }
});

export default router;

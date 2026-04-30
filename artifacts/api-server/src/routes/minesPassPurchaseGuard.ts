import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, minesRoundPassesTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";
import { processCommission } from "./commissions";

const router: IRouter = Router();
const minesRateLimiter = createRouteRateLimiter("mines-pass-purchase-guard", { limit: 12, windowMs: 10_000, message: "Too many pass purchase requests. Slow down and try again." });
const TONAPI_BASE = "https://tonapi.io/v2";
const TON_USD_APPROX = 3.50;
const getOperatorWallet = () => process.env.KOINARA_TON_WALLET;
type GcTierId = "bronze" | "silver" | "gold";
const TIERS: Record<GcTierId, { entryFeeTonNano: bigint; packSizes: number[] }> = {
  bronze: { entryFeeTonNano: 50_000_000n, packSizes: [1, 5, 10] },
  silver: { entryFeeTonNano: 100_000_000n, packSizes: [1, 5, 10] },
  gold: { entryFeeTonNano: 250_000_000n, packSizes: [1, 5, 10] },
};
const Body = z.object({ telegramId: z.string().min(1), tier: z.enum(["bronze", "silver", "gold"]), packSize: z.number().int().min(1).max(10), senderAddress: z.string().min(1) });
const Query = z.object({ telegramId: z.string().min(1), tier: z.enum(["bronze", "silver", "gold"]), packSize: z.coerce.number().int().min(1).max(10) });

type TonApiAccount = { address: string };
type TonApiTx = { hash: string; utime: number; out_msgs: Array<{ destination?: { address?: string }; value?: number; decoded_body?: { text?: string } }> };
type TonApiTxList = { transactions: TonApiTx[] };
function minesPassMemo(telegramId: string, tier: GcTierId, packSize: number): string { return `KNR-MINES-${tier}-${packSize}-${telegramId}`; }
function totalNano(tier: GcTierId, packSize: number): bigint {
  const base = TIERS[tier].entryFeeTonNano;
  if (packSize === 1) return base;
  if (packSize === 5) return (base * 39n) / 10n;
  return (base * 69n) / 10n;
}
function tonUsd(nano: bigint): number {
  return (Number(nano) / 1e9) * TON_USD_APPROX;
}
async function tonapiGet<T>(path: string): Promise<{ data: T | null; err?: string }> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
    if (!resp.ok) return { data: null, err: `tonapi ${resp.status}` };
    return { data: (await resp.json()) as T };
  } catch { return { data: null, err: "TON API unreachable" }; }
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

router.get("/mines/passes/memo", (req, res): void => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  if (!TIERS[parsed.data.tier].packSizes.includes(parsed.data.packSize)) { res.status(400).json({ error: "Invalid pack size." }); return; }
  res.json({ tier: parsed.data.tier, packSize: parsed.data.packSize, memo: minesPassMemo(telegramId, parsed.data.tier, parsed.data.packSize) });
});

router.post("/mines/passes/purchase", minesRateLimiter, async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body." }); return; }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  const { tier, packSize, senderAddress } = parsed.data;
  if (!TIERS[tier].packSizes.includes(packSize)) { res.status(400).json({ error: "Invalid pack size." }); return; }
  const requiredMemo = minesPassMemo(telegramId, tier, packSize);
  const passFeeNano = totalNano(tier, packSize);
  const verification = await verifyTonPayment(senderAddress, passFeeNano, requiredMemo);
  if (!verification.ok) { res.status(400).json({ error: verification.err ?? "Payment verification failed.", requiredMemo }); return; }
  const txHash = verification.txHash;
  if (!txHash) { res.status(500).json({ error: "TON verifier returned no tx hash." }); return; }
  try {
    const [pass] = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: minesRoundPassesTable.id }).from(minesRoundPassesTable).where(eq(minesRoundPassesTable.txHash, txHash)).limit(1);
      if (existing.length > 0) throw new Error("TX_ALREADY_USED");
      return tx.insert(minesRoundPassesTable).values({ telegramId, tier, remaining: packSize, txHash }).returning();
    });

    await processCommission({
      buyerTelegramId: telegramId,
      purchaseType: "mines_pass",
      grossUsd: tonUsd(passFeeNano),
      isRenewal: false,
    });

    logger.info({ telegramId, tier, packSize, txHash }, "Mines round pass purchased with bound memo");
    res.status(201).json({ passId: pass.id, tier, remaining: pass.remaining });
  } catch (err: any) {
    if (err?.message === "TX_ALREADY_USED" || err?.code === "23505") { res.status(409).json({ error: "This transaction has already been used to purchase passes." }); return; }
    logger.error({ err, telegramId, tier }, "Mines pass purchase failed");
    res.status(500).json({ error: "Failed to purchase round pass." });
  }
});
export default router;

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { processCommission } from "./commissions";
import { z } from "zod/v4";

const router: IRouter = Router();

// Creator Pass costs $0.99 ≈ 0.2 TON
const CREATOR_PASS_TON_NANO = BigInt("200000000"); // 0.2 TON in nanotons
const CREATOR_PASS_USD = 0.99;
const TONAPI_BASE = "https://tonapi.io/v2";

const getKoinaraWallet = () => process.env.KOINARA_TON_WALLET;

type TonApiAccount = { address: string };
type TonApiTx = {
  hash: string;
  utime: number;
  out_msgs: Array<{ destination?: { address?: string }; value?: number }>;
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

async function verifyCreatorPassTon(
  senderAddress: string,
): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = getKoinaraWallet();
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

  const minNano = (CREATOR_PASS_TON_NANO * 95n) / 100n;
  const nowSec = Math.floor(Date.now() / 1000);
  const RECENCY_WINDOW_SEC = 15 * 60;

  for (const tx of txList.transactions) {
    const ageSec = nowSec - (tx.utime ?? 0);
    if (ageSec > RECENCY_WINDOW_SEC) continue;
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
    err: "No matching Creator Pass payment found within the last 15 minutes.",
  };
}

const PurchaseCreatorPassBody = z.object({
  senderAddress: z.string(),
});

// ── POST /creator-pass/:telegramId/purchase ──────────────────────────────────
router.post("/creator-pass/:telegramId/purchase", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const body = PurchaseCreatorPassBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "senderAddress required" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.creatorPassPaid) {
    res.json({ success: true, alreadyOwned: true, message: "Creator Pass already active" });
    return;
  }

  if (!user.walletAddress) {
    res.status(400).json({ error: "Please connect your TON wallet before purchasing." });
    return;
  }

  const { senderAddress } = body.data;
  if (user.walletAddress.toLowerCase() !== senderAddress.toLowerCase()) {
    res.status(403).json({ error: "Sender address does not match your connected wallet." });
    return;
  }

  const verification = await verifyCreatorPassTon(senderAddress);
  if (!verification.ok) {
    const statusCode = verification.configErr ? 503 : 422;
    res.status(statusCode).json({ error: verification.err ?? "TON verification failed" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ creatorPassPaid: true })
    .where(eq(usersTable.telegramId, authedId))
    .returning();

  // Process commission for the Creator Pass purchase itself
  await processCommission({
    buyerTelegramId: authedId,
    purchaseType: "creator_pass",
    grossUsd: CREATOR_PASS_USD,
    isRenewal: false,
  });

  res.json({
    success: true,
    alreadyOwned: false,
    creatorPassPaid: true,
    txHash: verification.txHash,
    telegramId: updated.telegramId,
  });
});

// ── GET /creator-pass/:telegramId/status ─────────────────────────────────────
router.get("/creator-pass/:telegramId/status", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [user] = await db
    .select({
      creatorPassPaid: usersTable.creatorPassPaid,
      creatorCredits: usersTable.creatorCredits,
      totalCrEarned: usersTable.totalCrEarned,
    })
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
});

export default router;

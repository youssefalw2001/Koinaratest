import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, creatorPassTxHashesTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { serializeRow } from "../lib/serialize";
import { processCommission } from "./commissions";

const router: IRouter = Router();
const TONAPI_BASE = "https://tonapi.io/v2";
const CREATOR_PASS_USD = 0.99;
const CREATOR_PASS_TON_NANO = 200_000_000n;

type TonApiAccount = { address: string };
type TonApiTx = {
  hash: string;
  utime: number;
  out_msgs: Array<{
    destination?: { address?: string };
    value?: number;
    decoded_body?: { text?: string };
  }>;
};
type TonApiTxList = { transactions: TonApiTx[] };

const CreatorPassPurchaseBody = z.object({
  telegramId: z.string().min(1),
  paymentMethod: z.enum(["ton", "stars"]),
  senderAddress: z.string().min(1).optional(),
  txHash: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
  grossUsd: z.number().positive().optional(),
});

function creatorPassMemo(telegramId: string): string {
  return `KNR-CREATOR-PASS-${telegramId}`;
}

function getOperatorWallet(): string | undefined {
  return process.env.KOINARA_TON_WALLET || process.env.TON_WALLET;
}

async function tonapiGet<T>(path: string): Promise<T | null> {
  try {
    const resp = await fetch(`${TONAPI_BASE}${path}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

async function verifyCreatorPassTonPayment(senderAddress: string, telegramId: string): Promise<{ ok: true; txHash: string } | { ok: false; error: string; status?: number }> {
  const operatorWallet = getOperatorWallet();
  if (!operatorWallet) {
    return { ok: false, status: 503, error: "TON payment processing is not configured. Please contact support." };
  }

  const operatorAccount = await tonapiGet<TonApiAccount>(`/accounts/${encodeURIComponent(operatorWallet)}`);
  if (!operatorAccount?.address) {
    return { ok: false, status: 503, error: "TON verification is temporarily unavailable. Please retry in a moment." };
  }

  const txList = await tonapiGet<TonApiTxList>(`/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`);
  if (!txList?.transactions) {
    return { ok: false, status: 503, error: "TON verification is temporarily unavailable. Please retry in a moment." };
  }

  const expectedMemo = creatorPassMemo(telegramId);
  const minNano = (CREATOR_PASS_TON_NANO * 95n) / 100n;
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

  return {
    ok: false,
    status: 422,
    error: `No matching Creator Pass TON payment found. Send 0.2 TON with memo/comment "${expectedMemo}" and retry after confirmation.`,
  };
}

router.get("/creator/pass/memo", async (req, res): Promise<void> => {
  const parsed = z.object({ telegramId: z.string().min(1) }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;
  res.json({ memo: creatorPassMemo(telegramId), amountTon: "0.2", amountNano: CREATOR_PASS_TON_NANO.toString(), grossUsd: CREATOR_PASS_USD });
});

router.post("/creator/purchase-pass", async (req, res): Promise<void> => {
  const parsed = CreatorPassPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid Creator Pass purchase request." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.creatorPassPaid) {
    res.json(serializeRow(user as Record<string, unknown>));
    return;
  }

  const { paymentMethod } = parsed.data;
  let paymentRef: string | undefined;

  if (paymentMethod === "stars") {
    // Keep Stars closed until Telegram invoice verification is implemented.
    // This prevents fake Creator Pass activation through arbitrary invoice IDs.
    res.status(501).json({ error: "Stars Creator Pass checkout is not enabled yet. Please use TON for now." });
    return;
  }

  if (!parsed.data.senderAddress) {
    res.status(400).json({ error: "senderAddress is required for TON Creator Pass purchases." });
    return;
  }

  const verification = await verifyCreatorPassTonPayment(parsed.data.senderAddress, telegramId);
  if (!verification.ok) {
    res.status(verification.status ?? 422).json({ error: verification.error, requiredMemo: creatorPassMemo(telegramId) });
    return;
  }
  paymentRef = verification.txHash;

  const [existingPayment] = await db
    .select()
    .from(creatorPassTxHashesTable)
    .where(eq(creatorPassTxHashesTable.txHash, paymentRef))
    .limit(1);
  if (existingPayment) {
    res.status(409).json({ error: "This Creator Pass payment has already been used." });
    return;
  }

  const [updated] = await db.transaction(async (tx) => {
    await tx.insert(creatorPassTxHashesTable).values({
      txHash: paymentRef,
      telegramId,
      paymentMethod,
    });

    return tx
      .update(usersTable)
      .set({ creatorPassPaid: true, creatorPassPaidAt: new Date() })
      .where(eq(usersTable.telegramId, telegramId))
      .returning();
  });

  await processCommission({
    buyerTelegramId: telegramId,
    purchaseType: "creator_pass",
    grossUsd: CREATOR_PASS_USD,
    isRenewal: false,
  });

  res.status(200).json(serializeRow(updated as Record<string, unknown>));
});

export default router;

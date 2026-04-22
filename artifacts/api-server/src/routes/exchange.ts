import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, tcPackTxHashesTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------- TC Pack definitions ----------

type TcPack = {
  id: "small" | "medium" | "large" | "jumbo";
  label: string;
  priceTonNano: bigint;
  priceTonLabel: string;
  tcAwarded: number;
  bonusPct: number;
};

// Psychological pricing: bigger packs offer escalating bonus TC.
// Nanotons = 10^9 tons. Keep prices in bigint to avoid float rounding.
const TC_PACKS: readonly TcPack[] = [
  {
    id: "small",
    label: "Starter Pack",
    priceTonNano: 500_000_000n,      // 0.5 TON
    priceTonLabel: "0.5",
    tcAwarded: 1_000,
    bonusPct: 0,
  },
  {
    id: "medium",
    label: "Trader Pack",
    priceTonNano: 1_000_000_000n,    // 1.0 TON
    priceTonLabel: "1.0",
    tcAwarded: 2_500,                // 1000 base + 500 bonus vs 2 packs of small
    bonusPct: 25,
  },
  {
    id: "large",
    label: "Whale Pack",
    priceTonNano: 2_500_000_000n,    // 2.5 TON
    priceTonLabel: "2.5",
    tcAwarded: 7_500,
    bonusPct: 50,
  },
  {
    id: "jumbo",
    label: "Jumbo Vault",
    priceTonNano: 5_000_000_000n,    // 5.0 TON
    priceTonLabel: "5.0",
    tcAwarded: 20_000,
    bonusPct: 100,
  },
];

function findPack(id: string): TcPack | undefined {
  return TC_PACKS.find((p) => p.id === id);
}

const exchangeRateLimiter = createRouteRateLimiter("exchange-action", {
  limit: 12,
  windowMs: 10_000,
  message: "Too many exchange requests. Slow down and try again.",
});

// ---------- GET /exchange/tc-packs ----------

router.get("/exchange/tc-packs", (_req, res): void => {
  res.json({
    packs: TC_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      priceTon: p.priceTonLabel,
      priceTonNano: p.priceTonNano.toString(),
      tcAwarded: p.tcAwarded,
      bonusPct: p.bonusPct,
    })),
  });
});

// ---------- POST /exchange/tc-pack/purchase ----------

const TcPackPurchaseBody = z.object({
  telegramId: z.string().min(1),
  packId: z.enum(["small", "medium", "large", "jumbo"]),
  senderAddress: z.string().min(1),
});

// Lazy wallet reader so tests can toggle the env var.
const getOperatorWallet = () => process.env.KOINARA_TON_WALLET;
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

async function verifyTcPackTonTransaction(
  senderAddress: string,
  pack: TcPack,
): Promise<{ ok: boolean; err?: string; txHash?: string; configErr?: boolean }> {
  const walletEnv = getOperatorWallet();
  if (!walletEnv) {
    logger.error("[TC-PACK] KOINARA_TON_WALLET is not set — TON payment processing disabled");
    return {
      ok: false,
      err: "TON payment processing is not configured. Please contact support.",
      configErr: true,
    };
  }

  const { data: operatorAccount, err: resolveErr } = await tonapiGet<TonApiAccount>(
    `/accounts/${encodeURIComponent(walletEnv)}`,
  );
  if (!operatorAccount || resolveErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment." };
  }
  const operatorRaw = operatorAccount.address;

  const { data: txList, err: txErr } = await tonapiGet<TonApiTxList>(
    `/accounts/${encodeURIComponent(senderAddress)}/transactions?limit=50`,
  );
  if (!txList || txErr) {
    return { ok: false, err: "TON API unreachable — please retry in a moment." };
  }

  const expectedNano = pack.priceTonNano;
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

router.post(
  "/exchange/tc-pack/purchase",
  exchangeRateLimiter,
  async (req, res): Promise<void> => {
    const parsed = TcPackPurchaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
      return;
    }

    const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
    if (!telegramId) return;
    const { packId, senderAddress } = parsed.data;

    const pack = findPack(packId);
    if (!pack) {
      res.status(400).json({ error: "Unknown pack." });
      return;
    }

    const verification = await verifyTcPackTonTransaction(senderAddress, pack);
    if (!verification.ok) {
      res.status(verification.configErr ? 503 : 400).json({
        error: verification.err ?? "TON payment verification failed.",
      });
      return;
    }
    const txHash = verification.txHash;
    if (!txHash) {
      res.status(500).json({ error: "TON verifier returned no tx hash." });
      return;
    }

    // Idempotency via unique tx hash — a given on-chain payment can credit
    // exactly one TC pack purchase, regardless of how many times the client
    // retries.
    try {
      const result = await db.transaction(async (tx) => {
        // Reserve the tx hash first so parallel retries can't double-credit.
        try {
          await tx.insert(tcPackTxHashesTable).values({
            txHash,
            telegramId,
            pack: pack.id,
            tcAwarded: pack.tcAwarded,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
            throw new Error("TX_ALREADY_USED");
          }
          throw err;
        }

        await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${pack.tcAwarded}` })
          .where(eq(usersTable.telegramId, telegramId));

        const [updated] = await tx
          .select({
            tradeCredits: usersTable.tradeCredits,
            goldCoins: usersTable.goldCoins,
          })
          .from(usersTable)
          .where(eq(usersTable.telegramId, telegramId))
          .limit(1);

        return updated;
      });

      logger.info(
        { telegramId, pack: pack.id, tcAwarded: pack.tcAwarded, txHash },
        "TC pack purchased",
      );

      res.status(200).json({
        pack: pack.id,
        tcAwarded: pack.tcAwarded,
        txHash,
        balances: {
          goldCoins: result?.goldCoins ?? 0,
          tradeCredits: result?.tradeCredits ?? 0,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "UNKNOWN";
      if (msg === "TX_ALREADY_USED") {
        res.status(409).json({
          error: "This TON payment has already been credited. If your TC balance looks wrong, contact support.",
        });
        return;
      }
      logger.error({ err, telegramId, pack: pack.id, txHash }, "TC pack purchase failed");
      res.status(500).json({ error: "TC pack credit failed. Please contact support." });
    }
  },
);

export default router;

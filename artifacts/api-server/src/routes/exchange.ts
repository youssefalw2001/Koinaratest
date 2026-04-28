import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, tcPackTxHashesTable, platformDailyStatsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------- TC Pack definitions ----------

type TcPack = {
  id: "micro" | "starter" | "pro" | "whale";
  label: string;
  priceTonNano: bigint;
  priceTonLabel: string;
  priceUsdLabel: string;    // display-only USD price shown in the UI
  tcAwarded: number;
  bonusPct: number;
};

// Prices in TON (nanotons). USD labels are for display only — actual payment is on-chain TON.
// TON prices approximate: micro≈$0.99, starter≈$2.99, pro≈$9.99, whale≈$49.99 at current rates.
const TC_PACKS: readonly TcPack[] = [
  {
    id: "micro",
    label: "Micro Pack",
    priceTonNano: 200_000_000n,      // ~0.2 TON ≈ $0.99
    priceTonLabel: "0.2",
    priceUsdLabel: "$0.99",
    tcAwarded: 7_000,
    bonusPct: 0,
  },
  {
    id: "starter",
    label: "Starter Pack",
    priceTonNano: 600_000_000n,      // ~0.6 TON ≈ $2.99
    priceTonLabel: "0.6",
    priceUsdLabel: "$2.99",
    tcAwarded: 30_000,
    bonusPct: 0,
  },
  {
    id: "pro",
    label: "Pro Pack",
    priceTonNano: 2_000_000_000n,    // ~2.0 TON ≈ $9.99
    priceTonLabel: "2.0",
    priceUsdLabel: "$9.99",
    tcAwarded: 150_000,
    bonusPct: 0,
  },
  {
    id: "whale",
    label: "Whale Pack",
    priceTonNano: 10_000_000_000n,   // ~10.0 TON ≈ $49.99
    priceTonLabel: "10.0",
    priceUsdLabel: "$49.99",
    tcAwarded: 1_000_000,
    bonusPct: 0,
  },
];

function findPack(id: string): TcPack | undefined {
  return TC_PACKS.find((p) => p.id === id);
}

function tcPackMemo(telegramId: string, packId: TcPack["id"]): string {
  return `KNR-PACK-${packId}-${telegramId}`;
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
      priceUsd: p.priceUsdLabel,
      tcAwarded: p.tcAwarded,
      bonusPct: p.bonusPct,
    })),
  });
});

// ---------- GET /exchange/tc-pack/memo ----------
// Authenticated helper for frontend payment construction.
router.get("/exchange/tc-pack/memo", (req, res): void => {
  const query = z.object({ telegramId: z.string().min(1), packId: z.enum(["micro", "starter", "pro", "whale"]) }).safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.issues[0]?.message ?? "Invalid query." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, query.data.telegramId);
  if (!telegramId) return;
  const pack = findPack(query.data.packId);
  if (!pack) {
    res.status(400).json({ error: "Unknown pack." });
    return;
  }
  res.json({ packId: pack.id, memo: tcPackMemo(telegramId, pack.id) });
});

// ---------- POST /exchange/tc-pack/purchase ----------

const TcPackPurchaseBody = z.object({
  telegramId: z.string().min(1),
  packId: z.enum(["micro", "starter", "pro", "whale"]),
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
    decoded_body?: { text?: string };
    decoded_op_name?: string;
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
  expectedMemo: string,
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
      if (valueNano < minNano) continue;
      const comment = msg.decoded_body?.text ?? "";
      if (comment !== expectedMemo) continue;
      return { ok: true, txHash: tx.hash };
    }
  }

  return {
    ok: false,
    err: `No matching TON payment found within the last 15 minutes. Please include the exact memo/comment "${expectedMemo}" and retry after confirmation.`,
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

    const expectedMemo = tcPackMemo(telegramId, pack.id);
    const verification = await verifyTcPackTonTransaction(senderAddress, pack, expectedMemo);
    if (!verification.ok) {
      res.status(verification.configErr ? 503 : 400).json({
        error: verification.err ?? "TON payment verification failed.",
        requiredMemo: expectedMemo,
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

        // Track revenue so the daily payout cap reflects TC pack sales
        const todayDate = new Date().toISOString().split("T")[0];
        const packRevenueGc = Math.floor(Number(pack.priceTonNano) / 1e9 * 2500);
        await tx
          .insert(platformDailyStatsTable)
          .values({ date: todayDate, totalRevenueGc: packRevenueGc })
          .onConflictDoUpdate({
            target: platformDailyStatsTable.date,
            set: { totalRevenueGc: sql`platform_daily_stats.total_revenue_gc + ${packRevenueGc}` },
          });

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

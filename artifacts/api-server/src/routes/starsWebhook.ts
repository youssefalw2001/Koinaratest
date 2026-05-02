import { Router, type IRouter, type Request } from "express";
import { eq, sql } from "drizzle-orm";
import { db, gemInventoryTable, minesRoundPassesTable, starsTransactionsTable, usersTable } from "@workspace/db";
import { findStarsProduct, parseStarsPayload } from "../lib/starsCatalog";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type TelegramPreCheckoutQuery = {
  id: string;
  from?: { id?: number };
  invoice_payload?: string;
};

type TelegramSuccessfulPayment = {
  currency?: string;
  total_amount?: number;
  invoice_payload?: string;
  telegram_payment_charge_id?: string;
};

type TelegramUpdate = {
  pre_checkout_query?: TelegramPreCheckoutQuery;
  message?: {
    from?: { id?: number };
    successful_payment?: TelegramSuccessfulPayment;
  };
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getBotToken(): string | null {
  const primary = process.env.TELEGRAM_BOT_TOKEN?.split(",")[0]?.trim();
  if (primary) return primary;
  const extraKey = ["TELEGRAM", "BOT", "TOKENS"].join("_");
  return ((process.env as Record<string, string | undefined>)[extraKey] ?? "").split(",")[0]?.trim() || null;
}

function getOptionalWebhookSecret(): string | null {
  return process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
}

function requestHasValidSecret(req: Request): boolean {
  const secret = getOptionalWebhookSecret();
  if (!secret) return true;
  return req.headers["x-telegram-bot-api-secret-token"] === secret;
}

async function answerPreCheckoutQuery(queryId: string, ok: boolean, errorMessage?: string): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) throw new Error("BOT_TOKEN_NOT_CONFIGURED");
  await fetch(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pre_checkout_query_id: queryId, ok, error_message: errorMessage }),
  });
}

async function ensureStarsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stars_transactions (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL,
      stars_amount INTEGER NOT NULL,
      product_type TEXT NOT NULL,
      product_id TEXT NOT NULL,
      telegram_payment_charge_id TEXT UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stars_transactions_telegram_id ON stars_transactions (telegram_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_stars_transactions_charge_id ON stars_transactions (telegram_payment_charge_id)`);
}

function expiresAt(hours?: number | null): Date | null {
  return typeof hours === "number" && hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
}

async function processCompletedStarsPayment(input: {
  telegramId: string;
  starsAmount: number;
  payload: string;
  telegramPaymentChargeId: string;
}) {
  const parsed = parseStarsPayload(input.payload);
  if (!parsed) throw new Error("INVALID_STARS_PAYLOAD");
  if (parsed.telegramId !== input.telegramId) throw new Error("PAYER_MISMATCH");

  const product = findStarsProduct(parsed.productType, parsed.productId);
  if (!product) throw new Error("UNKNOWN_STARS_PRODUCT");
  if (product.starsAmount !== input.starsAmount) throw new Error("STARS_AMOUNT_MISMATCH");

  await ensureStarsTable();

  return db.transaction(async (tx) => {
    await tx.insert(starsTransactionsTable).values({
      telegramId: input.telegramId,
      starsAmount: input.starsAmount,
      productType: product.productType,
      productId: product.productId,
      telegramPaymentChargeId: input.telegramPaymentChargeId,
      payload: input.payload,
      status: "completed",
    });

    if (product.productType === "tc_pack") {
      if (!product.tcAmount) throw new Error("INVALID_TC_PACK_CONFIG");
      await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${product.tcAmount}` })
        .where(eq(usersTable.telegramId, input.telegramId));

      const revenueGc = Math.floor(product.starsAmount * 0.013 * 0.70 * 2500);
      const date = todayStr();
      await tx.execute(sql`
        INSERT INTO platform_daily_stats (date, total_revenue_gc)
        VALUES (${date}, ${revenueGc})
        ON CONFLICT (date)
        DO UPDATE SET total_revenue_gc = platform_daily_stats.total_revenue_gc + ${revenueGc}
      `);
    }

    if (product.productType === "gem") {
      if (!product.gemType || !product.gemUses) throw new Error("INVALID_GEM_CONFIG");
      await tx.insert(gemInventoryTable).values({
        telegramId: input.telegramId,
        gemType: product.gemType,
        usesRemaining: product.gemUses,
        expiresAt: expiresAt(product.expiresHours),
      });
    }

    if (product.productType === "mines_pass") {
      if (!product.minesTier || !product.minesPasses) throw new Error("INVALID_MINES_PASS_CONFIG");
      await tx.insert(minesRoundPassesTable).values({
        telegramId: input.telegramId,
        tier: product.minesTier,
        remaining: product.minesPasses,
        txHash: `stars:${input.telegramPaymentChargeId}`,
      });
    }

    const [updated] = await tx
      .select({ tradeCredits: usersTable.tradeCredits, goldCoins: usersTable.goldCoins })
      .from(usersTable)
      .where(eq(usersTable.telegramId, input.telegramId))
      .limit(1);

    return { productType: product.productType, productId: product.productId, balances: updated ?? null };
  });
}

router.post("/webhook/stars/payment", async (req, res): Promise<void> => {
  if (!requestHasValidSecret(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const update = req.body as TelegramUpdate;

  if (update.pre_checkout_query?.id) {
    const query = update.pre_checkout_query;
    try {
      const parsed = parseStarsPayload(query.invoice_payload ?? "");
      const payerId = query.from?.id != null ? String(query.from.id) : null;
      const product = parsed ? findStarsProduct(parsed.productType, parsed.productId) : null;
      const ok = !!parsed && !!payerId && parsed.telegramId === payerId && !!product;
      await answerPreCheckoutQuery(query.id, ok, ok ? undefined : "Invalid Koinara Stars invoice.");
      res.json({ ok: true });
      return;
    } catch (err) {
      logger.error({ err }, "Stars pre-checkout answer failed");
      res.status(200).json({ ok: true });
      return;
    }
  }

  const payment = update.message?.successful_payment;
  if (payment?.invoice_payload && payment.telegram_payment_charge_id) {
    const payerId = update.message?.from?.id != null ? String(update.message.from.id) : null;
    if (!payerId) {
      res.status(200).json({ ok: true });
      return;
    }

    try {
      const result = await processCompletedStarsPayment({
        telegramId: payerId,
        starsAmount: payment.total_amount ?? 0,
        payload: payment.invoice_payload,
        telegramPaymentChargeId: payment.telegram_payment_charge_id,
      });
      logger.info({ telegramId: payerId, chargeId: payment.telegram_payment_charge_id, result }, "Stars payment credited");
      res.json({ ok: true });
      return;
    } catch (err: any) {
      if (err?.code === "23505") {
        logger.warn({ chargeId: payment.telegram_payment_charge_id }, "Duplicate Stars payment ignored");
        res.json({ ok: true, duplicate: true });
        return;
      }
      logger.error({ err, chargeId: payment.telegram_payment_charge_id }, "Stars payment processing failed");
      res.status(200).json({ ok: true });
      return;
    }
  }

  res.json({ ok: true });
});

export default router;

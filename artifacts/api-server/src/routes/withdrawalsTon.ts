import { Router, type IRouter } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, withdrawalQueueTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const FREE_MIN_GC = 14000;
const VIP_MIN_GC = 2500;
const FEE_PCT = 0.06;
const TON_ADDRESS_REGEX = /^[A-Za-z0-9:_-]{20,120}$/;

const Body = z.object({
  telegramId: z.string().min(1),
  gcAmount: z.number().int().positive(),
  walletAddress: z.string().regex(TON_ADDRESS_REGEX, "Invalid TON wallet address."),
});

router.post("/withdrawals/request-ton", async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid USDT TON withdrawal request." });
    return;
  }

  const { telegramId, gcAmount, walletAddress } = parsed.data;
  const idempotency = await beginIdempotency(req, {
    scope: "withdrawals.request-ton",
    requireHeader: false,
    fingerprintData: { telegramId, gcAmount, walletAddress, payoutNetwork: "usdt_ton" },
    ttlMs: 6 * 60 * 60 * 1000,
  });
  if (idempotency.kind === "replay") { res.status(idempotency.statusCode).json(idempotency.responseBody); return; }
  if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") { res.status(409).json({ error: idempotency.message }); return; }
  if (idempotency.kind !== "acquired" && idempotency.kind !== "missing") { res.status(500).json({ error: "Idempotency precondition failed." }); return; }
  const handle = idempotency.kind === "acquired" ? idempotency : null;
  const reply = async (statusCode: number, payload: unknown) => {
    if (handle) await handle.commit(statusCode, payload);
    res.status(statusCode).json(payload);
  };

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) { if (handle) await handle.abort(); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) { await reply(404, { error: "User not found" }); return; }

  const now = new Date();
  const isVipUser = !!(user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now) || !!(user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > now);
  if (!isVipUser && !user.hasVerified) {
    await reply(403, { error: "One-time withdrawal verification required before gameplay GC withdrawals.", code: "VERIFICATION_REQUIRED" });
    return;
  }

  const gcPerUsd = isVipUser ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const minGc = isVipUser ? VIP_MIN_GC : FREE_MIN_GC;
  if (gcAmount < minGc) { await reply(400, { error: `Minimum withdrawal is ${minGc.toLocaleString()} GC.` }); return; }
  if ((user.goldCoins ?? 0) < gcAmount) { await reply(400, { error: `Insufficient balance. You have ${(user.goldCoins ?? 0).toLocaleString()} GC.` }); return; }

  const feeGc = Math.floor(gcAmount * FEE_PCT);
  const netGc = gcAmount - feeGc;
  const usdValue = gcAmount / gcPerUsd;
  const netUsd = netGc / gcPerUsd;
  const tier = isVipUser ? "vip" : "free";

  try {
    await db.transaction(async (tx) => {
      const updated = await tx.update(usersTable).set({ goldCoins: sql`${usersTable.goldCoins} - ${gcAmount}` }).where(and(eq(usersTable.telegramId, authedId), gte(usersTable.goldCoins, gcAmount))).returning();
      if (updated.length === 0) throw new Error("INSUFFICIENT_BALANCE");
      await tx.insert(withdrawalQueueTable).values({
        telegramId: authedId,
        amountGc: gcAmount,
        feePct: FEE_PCT,
        feeGc,
        netGc,
        usdValue,
        netUsd,
        walletAddress,
        payoutNetwork: "usdt_ton",
        isVip: isVipUser ? 1 : 0,
        tier,
        status: "pending",
      });
    });
  } catch (err) {
    if (handle) await handle.abort();
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") { res.status(400).json({ error: "Insufficient balance." }); return; }
    throw err;
  }

  logger.info({ telegramId: authedId, gcAmount, netUsd, payoutNetwork: "usdt_ton", walletSuffix: walletAddress.slice(-6) }, "USDT TON GC withdrawal queued");
  await reply(200, { success: true, gcDeducted: gcAmount, netUsd: parseFloat(netUsd.toFixed(4)), feeUsd: parseFloat((feeGc / gcPerUsd).toFixed(4)), payoutNetwork: "usdt_ton", walletAddress, estimatedTime: isVipUser ? "~4 hours" : "48–72 hours" });
});

export default router;

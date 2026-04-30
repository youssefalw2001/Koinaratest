import { Router, type IRouter } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, crTransactionsTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { beginIdempotency } from "../lib/idempotency";
import { getApprovedCreatorCrBalance, CR_PER_USD } from "./commissions";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MIN_CR_WITHDRAWAL = 1000;
const CR_FEE_PCT = 0.10;
const TRC20_REGEX = /^T[A-Za-z1-9]{33}$/;

const CreatorWithdrawalBody = z.object({
  telegramId: z.string().min(1),
  crAmount: z.number().int().min(MIN_CR_WITHDRAWAL),
  walletAddress: z.string()
    .min(34, "USDT TRC-20 address must be 34 characters")
    .max(34, "USDT TRC-20 address must be 34 characters")
    .regex(TRC20_REGEX, "Invalid TRC-20 address format. Must start with 'T' and be 34 characters."),
});

router.post("/withdrawals/creator", async (req, res): Promise<void> => {
  const parsed = CreatorWithdrawalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid creator withdrawal request." });
    return;
  }

  const { telegramId, crAmount, walletAddress } = parsed.data;
  const idempotency = await beginIdempotency(req, {
    scope: "withdrawals.creator",
    requireHeader: false,
    fingerprintData: { telegramId, crAmount, walletAddress },
    ttlMs: 6 * 60 * 60 * 1000,
  });
  if (idempotency.kind === "replay") { res.status(idempotency.statusCode).json(idempotency.responseBody); return; }
  if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") { res.status(409).json({ error: idempotency.message }); return; }
  if (idempotency.kind !== "acquired" && idempotency.kind !== "missing") { res.status(500).json({ error: "Idempotency precondition failed." }); return; }
  const idempotencyHandle = idempotency.kind === "acquired" ? idempotency : null;
  const reply = async (statusCode: number, payload: unknown) => {
    if (idempotencyHandle) await idempotencyHandle.commit(statusCode, payload);
    res.status(statusCode).json(payload);
  };

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) { if (idempotencyHandle) await idempotencyHandle.abort(); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) { await reply(404, { error: "User not found" }); return; }
  if (!user.creatorPassPaid) { await reply(403, { error: "Creator Pass required before CR withdrawal." }); return; }

  const approvedCr = await getApprovedCreatorCrBalance(authedId);
  if (crAmount > approvedCr) {
    await reply(400, { error: `Only approved CR can be withdrawn. Approved balance: ${approvedCr.toLocaleString()} CR.` });
    return;
  }
  if ((user.creatorCredits ?? 0) < crAmount) {
    await reply(400, { error: `Insufficient CR balance. You have ${(user.creatorCredits ?? 0).toLocaleString()} CR.` });
    return;
  }

  const netCr = Math.floor(crAmount * (1 - CR_FEE_PCT));
  const netUsd = netCr / CR_PER_USD;
  const feeCr = crAmount - netCr;

  try {
    await db.transaction(async (tx) => {
      const updated = await tx.update(usersTable).set({
        creatorCredits: sql`${usersTable.creatorCredits} - ${crAmount}`,
        totalCrWithdrawn: sql`${usersTable.totalCrWithdrawn} + ${crAmount}`,
      }).where(and(eq(usersTable.telegramId, authedId), gte(usersTable.creatorCredits, crAmount))).returning();

      if (updated.length === 0) throw new Error("INSUFFICIENT_CR_BALANCE");

      await tx.insert(crTransactionsTable).values({
        telegramId: authedId,
        type: "withdrawal",
        crAmount: -crAmount,
        sourceType: "content",
        sourceTelegramId: null,
        usdEquivalent: netUsd,
        status: "pending",
      });
    });
  } catch (err) {
    if (idempotencyHandle) await idempotencyHandle.abort();
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "INSUFFICIENT_CR_BALANCE") { res.status(400).json({ error: "Insufficient CR balance." }); return; }
    throw err;
  }

  logger.info({ telegramId: authedId, crAmount, feeCr, netCr, netUsd, walletSuffix: walletAddress.slice(-6) }, "Creator CR withdrawal queued");
  await reply(200, { success: true, crDeducted: crAmount, feeCr, netCr, netUsd: parseFloat(netUsd.toFixed(4)), estimatedTime: "48–72 hours", walletAddress });
});

export default router;

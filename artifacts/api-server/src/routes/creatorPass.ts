import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, usersTable, creatorPassTxHashesTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { serializeRow } from "../lib/serialize";
import { processCommission } from "./commissions";

const router: IRouter = Router();

const CreatorPassPurchaseBody = z.object({
  telegramId: z.string().min(1),
  paymentMethod: z.enum(["ton", "stars"]),
  txHash: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
  grossUsd: z.number().positive().default(0.99),
});

router.post("/creator/purchase-pass", async (req, res): Promise<void> => {
  const parsed = CreatorPassPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid Creator Pass purchase request." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!telegramId) return;

  const { paymentMethod } = parsed.data;
  const paymentRef = paymentMethod === "ton" ? parsed.data.txHash : parsed.data.invoiceId;
  if (!paymentRef) {
    res.status(400).json({ error: paymentMethod === "ton" ? "txHash is required for TON Creator Pass purchases." : "invoiceId is required for Stars Creator Pass purchases." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.creatorPassPaid) {
    res.json(serializeRow(user as Record<string, unknown>));
    return;
  }

  const [existingPayment] = await db
    .select()
    .from(creatorPassTxHashesTable)
    .where(eq(creatorPassTxHashesTable.txHash, paymentRef))
    .limit(1);
  if (existingPayment) {
    res.status(409).json({ error: "This Creator Pass payment has already been used." });
    return;
  }

  // TODO: Before launch, verify TON txHash on-chain and Stars invoiceId with Telegram.
  // This endpoint currently prevents duplicate payment references and activates the pass
  // only after the client submits a payment reference.
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
    grossUsd: 0.99,
    isRenewal: false,
  });

  res.status(200).json(serializeRow(updated as Record<string, unknown>));
});

export default router;

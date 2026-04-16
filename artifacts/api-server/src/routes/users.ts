import { Router, type IRouter } from "express";
import { eq, count, sql, desc } from "drizzle-orm";
import { db, usersTable, predictionsTable } from "@workspace/db";
import {
  RegisterUserBody,
  GetUserParams,
  GetUserResponse,
  GetUserStatsParams,
  GetUserStatsResponse,
  UpdateWalletParams,
  UpdateWalletBody,
  UpdateWalletResponse,
  UpgradeToVipParams,
  UpgradeToVipBody,
  UpgradeToVipResponse,
  RegisterUserResponse,
} from "@workspace/api-zod";
import { serializeRow } from "../lib/serialize";

const router: IRouter = Router();

const USER_SCHEMA = (row: Record<string, unknown>) =>
  RegisterUserResponse.parse(serializeRow(row));

router.post("/users/register", async (req, res): Promise<void> => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, username, firstName, lastName, photoUrl, referredBy } = parsed.data;
  const today = new Date().toISOString().split("T")[0];

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (existing.length > 0) {
    const existingUser = existing[0];
    const updateData: Record<string, unknown> = { username, firstName, lastName, photoUrl };

    // Day-7 survivor bonus: +3000 TC + 24h VIP trial (one-time, only if never set)
    if (existingUser.registrationDate && !existingUser.vipTrialExpiresAt) {
      const regDate = new Date(existingUser.registrationDate);
      const daysSinceReg = (Date.now() - regDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceReg >= 7) {
        const trialExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        updateData.vipTrialExpiresAt = trialExpiry;
        updateData.tradeCredits = sql`${usersTable.tradeCredits} + 3000`;
      }
    }

    const [updated] = await db
      .update(usersTable)
      .set(updateData)
      .where(eq(usersTable.telegramId, telegramId))
      .returning();
    res.json(USER_SCHEMA(updated as Record<string, unknown>));
    return;
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({
      telegramId,
      username,
      firstName,
      lastName,
      photoUrl,
      referredBy: referredBy ?? null,
      tradeCredits: 500,
      goldCoins: 0,
      totalGcEarned: 0,
      registrationDate: today,
    })
    .returning();

  res.status(200).json(USER_SCHEMA(newUser as Record<string, unknown>));
});

router.get("/users/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(GetUserResponse.parse(serializeRow(user as Record<string, unknown>)));
});

router.get("/users/:telegramId/stats", async (req, res): Promise<void> => {
  const params = GetUserStatsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { telegramId } = params.data;

  const preds = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.telegramId, telegramId));

  const resolved = preds.filter((p) => p.status !== "pending");
  const wins = resolved.filter((p) => p.status === "won").length;
  const losses = resolved.filter((p) => p.status === "lost").length;
  const totalTcWagered = preds.reduce((acc, p) => acc + p.amount, 0);
  const totalGcEarned = resolved
    .filter((p) => p.status === "won")
    .reduce((acc, p) => acc + (p.payout ?? 0), 0);
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;

  const referralCountResult = await db
    .select({ cnt: count() })
    .from(usersTable)
    .where(eq(usersTable.referredBy, telegramId));
  const referralCount = referralCountResult[0]?.cnt ?? 0;

  const allUsers = await db
    .select({ telegramId: usersTable.telegramId, totalGcEarned: usersTable.totalGcEarned })
    .from(usersTable)
    .orderBy(desc(usersTable.totalGcEarned));

  const rankIndex = allUsers.findIndex((u) => u.telegramId === telegramId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : allUsers.length + 1;

  res.json(GetUserStatsResponse.parse({
    totalPredictions: preds.length,
    wins,
    losses,
    winRate,
    totalTcWagered,
    totalGcEarned,
    referralCount: Number(referralCount),
    rank,
  }));
});

router.patch("/users/:telegramId/wallet", async (req, res): Promise<void> => {
  const params = UpdateWalletParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateWalletBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({ walletAddress: body.data.walletAddress })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateWalletResponse.parse(serializeRow(updated as Record<string, unknown>)));
});

router.post("/users/:telegramId/vip", async (req, res): Promise<void> => {
  const params = UpgradeToVipParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpgradeToVipBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const { plan, txHash } = body.data;
  const now = new Date();

  // Idempotency: if user is already VIP and it hasn't expired, return current state
  if (user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt) > now) {
    res.json(UpgradeToVipResponse.parse(serializeRow(user as Record<string, unknown>)));
    return;
  }

  // Paid TON plans (weekly/monthly) require verified on-chain payment — activation
  // is handled by the payment-flow task. Reject until that integration is live.
  if (plan === "weekly" || plan === "monthly") {
    res.status(501).json({
      error: "TON payment plans are not yet activated. Use TC plan or wait for on-chain verification.",
    });
    return;
  }

  if (plan === "tc") {
    const TC_FEE = 500;
    if (user.tradeCredits < TC_FEE) {
      res.status(400).json({ error: `Need ${TC_FEE} Trade Credits to activate VIP.` });
      return;
    }
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [updated] = await db
      .update(usersTable)
      .set({
        isVip: true,
        vipPlan: "tc_weekly",
        vipExpiresAt: expiresAt,
        tradeCredits: sql`${usersTable.tradeCredits} - ${TC_FEE}`,
      })
      .where(eq(usersTable.telegramId, params.data.telegramId))
      .returning();
    res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
    return;
  }

  const durationDays = plan === "monthly" ? 30 : 7;
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const [updated] = await db
    .update(usersTable)
    .set({
      isVip: true,
      vipPlan: plan,
      vipExpiresAt: expiresAt,
    })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
});

export default router;

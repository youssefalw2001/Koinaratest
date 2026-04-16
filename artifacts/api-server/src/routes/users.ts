import { Router, type IRouter } from "express";
import { eq, count, sql } from "drizzle-orm";
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
  UpgradeToVipResponse,
  RegisterUserResponse,
} from "@workspace/api-zod";
import { serializeRow, serializeRows } from "../lib/serialize";

const router: IRouter = Router();

router.post("/users/register", async (req, res): Promise<void> => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, username, firstName, lastName, photoUrl, referredBy } = parsed.data;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (existing.length > 0) {
    const updatedRows = await db
      .update(usersTable)
      .set({ username, firstName, lastName, photoUrl })
      .where(eq(usersTable.telegramId, telegramId))
      .returning();
    res.json(RegisterUserResponse.parse(serializeRow(updatedRows[0] as Record<string, unknown>)));
    return;
  }

  const newUserRows = await db
    .insert(usersTable)
    .values({
      telegramId,
      username,
      firstName,
      lastName,
      photoUrl,
      referredBy: referredBy ?? null,
      points: 500,
      totalEarned: 500,
    })
    .returning();

  const newUser = newUserRows[0];

  if (referredBy) {
    const referrer = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, referredBy))
      .limit(1);
    if (referrer.length > 0) {
      await db
        .update(usersTable)
        .set({
          points: sql`${usersTable.points} + 100`,
          totalEarned: sql`${usersTable.totalEarned} + 100`,
        })
        .where(eq(usersTable.telegramId, referredBy));
    }
  }

  res.status(200).json(RegisterUserResponse.parse(serializeRow(newUser as Record<string, unknown>)));
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
  const totalWagered = preds.reduce((acc, p) => acc + p.amount, 0);
  const totalPayout = resolved
    .filter((p) => p.status === "won")
    .reduce((acc, p) => acc + (p.payout ?? 0), 0);
  const netProfit = totalPayout - totalWagered;
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;

  const referralCountResult = await db
    .select({ cnt: count() })
    .from(usersTable)
    .where(eq(usersTable.referredBy, telegramId));
  const referralCount = referralCountResult[0]?.cnt ?? 0;

  const allUsers = await db
    .select({ telegramId: usersTable.telegramId, points: usersTable.points })
    .from(usersTable)
    .orderBy(sql`${usersTable.points} DESC`);

  const rankIndex = allUsers.findIndex((u) => u.telegramId === telegramId);
  const rank = rankIndex >= 0 ? rankIndex + 1 : allUsers.length + 1;

  const stats = {
    totalPredictions: preds.length,
    wins,
    losses,
    winRate,
    totalWagered,
    netProfit,
    referralCount: Number(referralCount),
    rank,
  };

  res.json(GetUserStatsResponse.parse(stats));
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

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.isVip) {
    res.status(400).json({ error: "Already VIP" });
    return;
  }

  const VIP_FEE = 500;

  if (user.points < VIP_FEE) {
    res.status(400).json({ error: `Insufficient points. Need ${VIP_FEE} Alpha Points.` });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set({
      isVip: true,
      points: sql`${usersTable.points} - ${VIP_FEE}`,
    })
    .where(eq(usersTable.telegramId, params.data.telegramId))
    .returning();

  res.json(UpgradeToVipResponse.parse(serializeRow(updated as Record<string, unknown>)));
});

export default router;

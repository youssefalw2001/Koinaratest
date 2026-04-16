import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, predictionsTable, usersTable } from "@workspace/db";
import {
  CreatePredictionBody,
  ResolvePredictionParams,
  ResolvePredictionBody,
  ResolvePredictionResponse,
  GetUserPredictionsParams,
  GetUserPredictionsQueryParams,
  GetUserPredictionsResponse,
  GetLeaderboardQueryParams,
  GetLeaderboardResponse,
} from "@workspace/api-zod";
import { serializeRow, serializeRows } from "../lib/serialize";

const router: IRouter = Router();

const PAYOUT_MULTIPLIER = 1.7;

router.post("/predictions", async (req, res): Promise<void> => {
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, direction, amount, entryPrice } = parsed.data;

  if (amount < 10) {
    res.status(400).json({ error: "Minimum bet is 10 Alpha Points" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (user.points < amount) {
    res.status(400).json({ error: "Insufficient Alpha Points" });
    return;
  }

  await db
    .update(usersTable)
    .set({ points: sql`${usersTable.points} - ${amount}` })
    .where(eq(usersTable.telegramId, telegramId));

  const [prediction] = await db
    .insert(predictionsTable)
    .values({ telegramId, direction, amount, entryPrice, status: "pending" })
    .returning();

  res.status(201).json(serializeRow(prediction as Record<string, unknown>));
});

router.post("/predictions/:id/resolve", async (req, res): Promise<void> => {
  const params = ResolvePredictionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = ResolvePredictionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { exitPrice } = body.data;

  const [prediction] = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.id, params.data.id))
    .limit(1);

  if (!prediction) {
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  if (prediction.status !== "pending") {
    res.status(400).json({ error: "Prediction already resolved" });
    return;
  }

  const priceWentUp = exitPrice > prediction.entryPrice;
  const isWin =
    (prediction.direction === "long" && priceWentUp) ||
    (prediction.direction === "short" && !priceWentUp);

  const payout = isWin ? Math.floor(prediction.amount * PAYOUT_MULTIPLIER) : 0;
  const status = isWin ? "won" : "lost";

  const [resolved] = await db
    .update(predictionsTable)
    .set({ exitPrice, status, payout, resolvedAt: new Date() })
    .where(eq(predictionsTable.id, params.data.id))
    .returning();

  if (isWin) {
    await db
      .update(usersTable)
      .set({
        points: sql`${usersTable.points} + ${payout}`,
        totalEarned: sql`${usersTable.totalEarned} + ${payout}`,
      })
      .where(eq(usersTable.telegramId, prediction.telegramId));
  }

  res.json(ResolvePredictionResponse.parse(serializeRow(resolved as Record<string, unknown>)));
});

router.get("/predictions/leaderboard", async (req, res): Promise<void> => {
  const query = GetLeaderboardQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 10) : 10;

  const users = await db
    .select({
      telegramId: usersTable.telegramId,
      username: usersTable.username,
      firstName: usersTable.firstName,
      points: usersTable.points,
      isVip: usersTable.isVip,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.points))
    .limit(Number(limit));

  const leaderboard = users.map((u, idx) => ({ ...u, rank: idx + 1 }));

  res.json(GetLeaderboardResponse.parse(leaderboard));
});

router.get("/predictions/user/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserPredictionsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const query = GetUserPredictionsQueryParams.safeParse(req.query);
  const limit = query.success ? (query.data.limit ?? 20) : 20;

  const preds = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.telegramId, params.data.telegramId))
    .orderBy(desc(predictionsTable.createdAt))
    .limit(Number(limit));

  res.json(GetUserPredictionsResponse.parse(serializeRows(preds as Record<string, unknown>[])));
});

export default router;

import { Router, type IRouter } from "express";
import { eq, desc, sql, and, or, gt, isNotNull } from "drizzle-orm";
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
  GetVipActivityResponse,
} from "@workspace/api-zod";
import { serializeRow, serializeRows } from "../lib/serialize";
import { isVipActive } from "../lib/vip";

const router: IRouter = Router();

const GC_RATIO = 0.85;
const DAILY_GC_CAP_FREE = 800;
const DAILY_GC_CAP_VIP = 3000;
const MIN_BET_TC = 50;
const ROUND_DURATION_SEC = 60;
const RESOLVE_TOLERANCE_SEC = 0;

router.post("/predictions", async (req, res): Promise<void> => {
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, direction, amount, entryPrice } = parsed.data;

  if (amount < MIN_BET_TC) {
    res.status(400).json({ error: `Minimum bet is ${MIN_BET_TC} Trade Credits` });
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

  const vipActive = isVipActive(user);
  const maxBet = vipActive ? 5000 : 1000;
  if (amount > maxBet) {
    res.status(400).json({ error: `Maximum bet is ${maxBet} Trade Credits` });
    return;
  }

  if (user.tradeCredits < amount) {
    res.status(400).json({ error: "Insufficient Trade Credits" });
    return;
  }

  await db
    .update(usersTable)
    .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${amount}` })
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

  // Backend 60s enforcement: must wait at least (ROUND_DURATION_SEC - RESOLVE_TOLERANCE_SEC) seconds
  const elapsed = (Date.now() - new Date(prediction.createdAt).getTime()) / 1000;
  if (elapsed < ROUND_DURATION_SEC - RESOLVE_TOLERANCE_SEC) {
    res.status(400).json({
      error: `Round not complete. ${Math.ceil(ROUND_DURATION_SEC - elapsed)}s remaining.`,
    });
    return;
  }

  const priceWentUp = exitPrice > prediction.entryPrice;
  const isWin =
    (prediction.direction === "long" && priceWentUp) ||
    (prediction.direction === "short" && !priceWentUp);

  let gcPayout = 0;

  if (isWin) {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.telegramId, prediction.telegramId))
      .limit(1);

    if (user) {
      const today = new Date().toISOString().split("T")[0];
      const currentDailyGc = user.dailyGcDate === today ? user.dailyGcEarned : 0;
      const vipNow = isVipActive(user);
      const dailyCap = vipNow ? DAILY_GC_CAP_VIP : DAILY_GC_CAP_FREE;
      // Payout is always bet_TC × 0.85; VIP advantage is a higher daily earning cap only
      const rawPayout = Math.floor(prediction.amount * GC_RATIO);
      const remaining = dailyCap - currentDailyGc;
      gcPayout = Math.min(rawPayout, Math.max(0, remaining));

      if (gcPayout > 0) {
        const newDailyGc = currentDailyGc + gcPayout;
        await db
          .update(usersTable)
          .set({
            goldCoins: sql`${usersTable.goldCoins} + ${gcPayout}`,
            totalGcEarned: sql`${usersTable.totalGcEarned} + ${gcPayout}`,
            dailyGcEarned: newDailyGc,
            dailyGcDate: today,
          })
          .where(eq(usersTable.telegramId, prediction.telegramId));
      }
    }
  }

  const status = isWin ? "won" : "lost";

  const [resolved] = await db
    .update(predictionsTable)
    .set({ exitPrice, status, payout: gcPayout, resolvedAt: new Date() })
    .where(eq(predictionsTable.id, params.data.id))
    .returning();

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
      goldCoins: usersTable.goldCoins,
      totalGcEarned: usersTable.totalGcEarned,
      isVip: usersTable.isVip,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.totalGcEarned))
    .limit(Number(limit));

  const leaderboard = users.map((u, idx) => ({ ...u, rank: idx + 1 }));
  res.json(GetLeaderboardResponse.parse(leaderboard));
});

router.get("/predictions/vip-activity", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: predictionsTable.id,
      payout: predictionsTable.payout,
      resolvedAt: predictionsTable.resolvedAt,
      username: usersTable.username,
      firstName: usersTable.firstName,
      telegramId: usersTable.telegramId,
    })
    .from(predictionsTable)
    .innerJoin(usersTable, eq(predictionsTable.telegramId, usersTable.telegramId))
    .where(
      and(
        eq(predictionsTable.status, "won"),
        or(
          and(
            eq(usersTable.isVip, true),
            isNotNull(usersTable.vipExpiresAt),
            gt(usersTable.vipExpiresAt, new Date()),
          ),
          and(
            isNotNull(usersTable.vipTrialExpiresAt),
            gt(usersTable.vipTrialExpiresAt, new Date()),
          ),
        ),
      ),
    )
    .orderBy(desc(predictionsTable.resolvedAt))
    .limit(10);

  const activity = rows.map((r) => {
    const raw = r.username ?? r.firstName ?? `VIP_${r.telegramId.slice(-4)}`;
    const truncated = raw.length > 10 ? `${raw.slice(0, 8)}..` : raw;
    return {
      displayName: `${truncated}_${Math.floor(1000 + Math.random() * 8999)}`,
      payout: r.payout ?? 0,
      resolvedAt: r.resolvedAt
        ? new Date(r.resolvedAt).toISOString()
        : new Date().toISOString(),
    };
  });

  res.json(GetVipActivityResponse.parse(activity));
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

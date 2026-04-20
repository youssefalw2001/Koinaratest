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
import { resolvePredictionLogic } from "../lib/resolveLogic";
import { logger } from "../lib/logger";
import { beginIdempotency } from "../lib/idempotency";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";

const router: IRouter = Router();

const MIN_BET_TC = 50;
const RESOLVE_TOLERANCE_SEC = 0;

// Koinara now runs a single 60s round with a fixed 1.85x base multiplier.
// VIP users still receive an additional +0.1 multiplier bonus.
const DURATION_TIERS: Record<number, number> = {
  60: 1.85,
};
const VIP_MULTIPLIER_BONUS = 0.1;
const MULTIPLIER_TOLERANCE = 0.001;
const DEFAULT_DURATION_SEC = 60;

router.post("/predictions", async (req, res): Promise<void> => {
  const parsed = CreatePredictionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { telegramId, direction, amount, entryPrice } = parsed.data;

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const requestedDuration =
    typeof (parsed.data as { duration?: number }).duration === "number"
      ? (parsed.data as { duration: number }).duration
      : DEFAULT_DURATION_SEC;
  // Multiplier is optional on the wire: when omitted we derive it server-side
  // from the duration + VIP state. When provided it must match the expected
  // value so UI/server can never disagree on the advertised payout.
  const rawMultiplier = (parsed.data as { multiplier?: number }).multiplier;
  const multiplierProvided = typeof rawMultiplier === "number";

  if (!(requestedDuration in DURATION_TIERS)) {
    res.status(400).json({ error: "Invalid duration. Allowed: 60." });
    return;
  }

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

  // Server-derived payout multiplier: duration tier + VIP bonus. If the client
  // sent a multiplier we validate it agrees (within tolerance) so the UI and
  // the server can never disagree on the advertised payout.
  const expectedMultiplier =
    DURATION_TIERS[requestedDuration] + (vipActive ? VIP_MULTIPLIER_BONUS : 0);
  if (
    multiplierProvided &&
    Math.abs((rawMultiplier as number) - expectedMultiplier) > MULTIPLIER_TOLERANCE
  ) {
    res.status(400).json({
      error: `Invalid multiplier for ${requestedDuration}s tier (expected ${expectedMultiplier}).`,
    });
    return;
  }

  await db
    .update(usersTable)
    .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${amount}` })
    .where(eq(usersTable.telegramId, telegramId));

  const [prediction] = await db
    .insert(predictionsTable)
    .values({
      telegramId,
      direction,
      amount,
      entryPrice,
      status: "pending",
      duration: requestedDuration,
      multiplier: expectedMultiplier,
    })
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
  const idempotency = await beginIdempotency(req, {
    scope: "predictions.resolve",
    fallbackKey: `prediction:${params.data.id}`,
    fingerprintData: { predictionId: params.data.id, exitPrice },
    ttlMs: 2 * 60 * 60 * 1000,
  });
  if (idempotency.kind === "missing") {
    res.status(400).json({ error: idempotency.message });
    return;
  }
  if (idempotency.kind === "replay") {
    res.status(idempotency.statusCode).json(idempotency.responseBody);
    return;
  }
  if (idempotency.kind === "in_progress" || idempotency.kind === "conflict") {
    res.status(409).json({ error: idempotency.message });
    return;
  }
  if (idempotency.kind !== "acquired") {
    res.status(500).json({ error: "Idempotency precondition failed." });
    return;
  }
  const idempotencyHandle = idempotency;

  const replyWithCommit = async (statusCode: number, payload: unknown): Promise<void> => {
    try {
      await idempotencyHandle.commit(statusCode, payload);
    } catch (err) {
      logger.warn({ err, predictionId: params.data.id }, "Failed to persist idempotent response");
    }
    res.status(statusCode).json(payload);
  };

  const [prediction] = await db
    .select()
    .from(predictionsTable)
    .where(eq(predictionsTable.id, params.data.id))
    .limit(1);

  if (!prediction) {
    await idempotencyHandle.abort();
    res.status(404).json({ error: "Prediction not found" });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, prediction.telegramId);
  if (!authedId) return;

  if (prediction.status !== "pending") {
    await replyWithCommit(400, { error: "Prediction already resolved" });
    return;
  }

  // Backend per-prediction duration enforcement: must wait at least
  // (prediction.duration - RESOLVE_TOLERANCE_SEC) seconds.
  const roundDuration = prediction.duration ?? DEFAULT_DURATION_SEC;
  const elapsed = (Date.now() - new Date(prediction.createdAt).getTime()) / 1000;
  if (elapsed < roundDuration - RESOLVE_TOLERANCE_SEC) {
    await replyWithCommit(400, {
      error: `Round not complete. ${Math.ceil(roundDuration - elapsed)}s remaining.`,
    });
    return;
  }

  const result = await resolvePredictionLogic(params.data.id, exitPrice, {
    autoResolved: false,
  });
  if (!result.ok || !result.prediction) {
    logger.warn(
      {
        predictionId: params.data.id,
        reason: result.reason ?? "unknown",
      },
      "Prediction resolve failed",
    );
    await idempotencyHandle.abort();
    res.status(400).json({ error: result.reason ?? "Failed to resolve" });
    return;
  }

  await replyWithCommit(
    200,
    ResolvePredictionResponse.parse(
      serializeRow(result.prediction as unknown as Record<string, unknown>),
    ),
  );
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
        gt(predictionsTable.payout, 0),
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

  const stableId = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff;
    return 1000 + (h % 9000);
  };

  const activity = rows.map((r) => {
    const raw = r.username ?? r.firstName ?? `VIP_${r.telegramId.slice(-4)}`;
    const truncated = raw.length > 10 ? `${raw.slice(0, 8)}..` : raw;
    return {
      displayName: `${truncated}_${stableId(r.telegramId)}`,
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

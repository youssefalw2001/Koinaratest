import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, crashBetsTable, crashRoundsTable, usersTable } from "@workspace/db";
import {
  CRASH_HOUSE_EDGE,
  createRoundFromStart,
  getAuthoritativeRoundLiveState,
  getCurrentRoundStart,
  type CrashRoundPhase,
  getRoundCycleMs,
  normalizeCrashRoundPhase,
} from "../lib/crashRuntime";
import { serializeRow, serializeRows } from "../lib/serialize";
import { createRouteRateLimiter } from "../lib/rateLimit";
import { beginIdempotency } from "../lib/idempotency";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MIN_BET_TC = 25;
const MAX_BET_TC = 5000;
const STREAM_TICK_MS = 750;

type CrashRoundRow = typeof crashRoundsTable.$inferSelect;
type CrashBetRow = typeof crashBetsTable.$inferSelect;
type CrashStatePayload = {
  houseEdge: number;
  cycleMs: number;
  serverTimeMs: number;
  round: {
    id: number;
    phase: "betting" | "running" | "crashed" | "settled";
    bettingOpensAt: string;
    bettingClosesAt: string;
    runningStartedAt: string;
    crashAt: string;
    crashMultiplier: number;
    seedHash: string;
    revealedSeed: string | null;
  };
  live: {
    elapsedSec: number;
    multiplier: number;
    crashed: boolean;
  };
};

const streamSubscribers = new Set<Response>();
let streamLoop: NodeJS.Timeout | null = null;
let streamTickInFlight = false;
const crashActionRateLimiter = createRouteRateLimiter("crash-action", {
  limit: 12,
  windowMs: 10_000,
  message: "Too many crash actions. Please slow down.",
});

function toClientPhase(phase: CrashRoundPhase): "betting" | "running" | "crashed" | "settled" {
  if (phase === "pending") return "betting";
  if (phase === "running") return "running";
  if (phase === "settled") return "settled";
  return "crashed";
}

async function ensureRoundForNow(): Promise<CrashRoundRow> {
  const [latest] = await db.select().from(crashRoundsTable).orderBy(desc(crashRoundsTable.id)).limit(1);
  const nowStart = getCurrentRoundStart();

  if (latest) {
    const latestStartMs = new Date(latest.bettingOpensAt).getTime();
    if (latestStartMs === nowStart.getTime()) return latest;
  }

  const next = createRoundFromStart(nowStart);
  const [created] = await db
    .insert(crashRoundsTable)
    .values({
      phase: "pending",
      houseEdge: CRASH_HOUSE_EDGE,
      seedHash: next.seedHash,
      revealedSeed: next.revealedSeed,
      crashMultiplier: next.crashMultiplier,
      bettingOpensAt: next.bettingOpensAt,
      bettingClosesAt: next.bettingClosesAt,
      runningStartedAt: next.runningStartedAt,
      crashAt: next.crashAt,
    })
    .returning();
  return created;
}

async function settleRoundInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  round: CrashRoundRow,
  referenceMs = Date.now(),
): Promise<CrashRoundRow> {
  const initialLive = getAuthoritativeRoundLiveState(round, referenceMs);
  if (initialLive.phase !== "crashed" && initialLive.phase !== "settled") {
    return round;
  }

  const [lockedRound] = await tx
    .select()
    .from(crashRoundsTable)
    .where(eq(crashRoundsTable.id, round.id))
    .for("update")
    .limit(1);

  if (!lockedRound) {
    return round;
  }

  const live = getAuthoritativeRoundLiveState(lockedRound, referenceMs);
  if (live.phase !== "crashed" && live.phase !== "settled") {
    return lockedRound;
  }

  const pendingBets = await tx
    .select({ id: crashBetsTable.id })
    .from(crashBetsTable)
    .where(and(eq(crashBetsTable.roundId, round.id), eq(crashBetsTable.status, "pending")))
    .for("update");

  if (pendingBets.length > 0) {
    await tx
      .update(crashBetsTable)
      .set({
        status: "lost",
        payoutGc: 0,
        resolvedAt: new Date(),
      })
      .where(inArray(crashBetsTable.id, pendingBets.map((bet) => bet.id)));
  }

  const [updatedRound] = await tx
    .update(crashRoundsTable)
    .set({ phase: "settled" })
    .where(eq(crashRoundsTable.id, round.id))
    .returning();

  logger.info(
    {
      roundId: round.id,
      previousPhase: normalizeCrashRoundPhase(lockedRound.phase),
      settledPhase: "settled",
      lostBets: pendingBets.length,
    },
    "Crash round settled on server",
  );

  return updatedRound ?? lockedRound;
}

async function settleRoundIfNeeded(round: CrashRoundRow): Promise<CrashRoundRow> {
  const live = getAuthoritativeRoundLiveState(round, Date.now());
  if (live.phase !== "crashed" && live.phase !== "settled") return round;
  return db.transaction((tx) => settleRoundInTransaction(tx, round, Date.now()));
}

async function buildCrashStatePayload(): Promise<CrashStatePayload> {
  const round = await ensureRoundForNow();
  const settledRound = await settleRoundIfNeeded(round);

  const nowMs = Date.now();
  const live = getAuthoritativeRoundLiveState(settledRound, nowMs);
  const phase = live.phase;
  if (normalizeCrashRoundPhase(settledRound.phase) !== phase) {
    await db
      .update(crashRoundsTable)
      .set({ phase })
      .where(eq(crashRoundsTable.id, settledRound.id));
  }

  return {
    houseEdge: CRASH_HOUSE_EDGE,
    cycleMs: getRoundCycleMs(),
    serverTimeMs: nowMs,
    round: {
      id: settledRound.id,
      phase: toClientPhase(phase),
      bettingOpensAt: new Date(settledRound.bettingOpensAt).toISOString(),
      bettingClosesAt: new Date(settledRound.bettingClosesAt).toISOString(),
      runningStartedAt: new Date(settledRound.runningStartedAt).toISOString(),
      crashAt: new Date(settledRound.crashAt).toISOString(),
      crashMultiplier: settledRound.crashMultiplier,
      seedHash: settledRound.seedHash,
      revealedSeed: live.crashed ? settledRound.revealedSeed : null,
    },
    live: {
      elapsedSec: live.elapsedSec,
      multiplier: live.multiplier,
      crashed: live.crashed,
    },
  };
}

function ensureStreamLoop(): void {
  if (streamLoop) return;
  streamLoop = setInterval(() => {
    void broadcastCrashState();
  }, STREAM_TICK_MS);
}

function stopStreamLoopIfIdle(): void {
  if (streamSubscribers.size > 0) return;
  if (!streamLoop) return;
  clearInterval(streamLoop);
  streamLoop = null;
}

async function broadcastCrashState(): Promise<void> {
  if (streamTickInFlight) return;
  if (streamSubscribers.size === 0) {
    stopStreamLoopIfIdle();
    return;
  }
  streamTickInFlight = true;
  try {
    const payload = await buildCrashStatePayload();
    const frame = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of [...streamSubscribers]) {
      try {
        res.write(frame);
      } catch {
        streamSubscribers.delete(res);
      }
    }
  } finally {
    streamTickInFlight = false;
    stopStreamLoopIfIdle();
  }
}

router.get("/crash/state", async (_req, res): Promise<void> => {
  const payload = await buildCrashStatePayload();
  res.json(payload);
});

router.get("/crash/stream", async (req, res): Promise<void> => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  streamSubscribers.add(res);
  res.write("retry: 1500\n\n");
  void broadcastCrashState();
  ensureStreamLoop();

  req.on("close", () => {
    streamSubscribers.delete(res);
    stopStreamLoopIfIdle();
  });
});

router.post("/crash/bet", crashActionRateLimiter, async (req, res): Promise<void> => {
  const requestedTelegramId = String(req.body?.telegramId ?? "").trim();
  const amountTc = Number(req.body?.amountTc);

  if (!requestedTelegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  if (!Number.isFinite(amountTc) || amountTc % 1 !== 0 || amountTc < MIN_BET_TC || amountTc > MAX_BET_TC) {
    res.status(400).json({ error: `amountTc must be an integer between ${MIN_BET_TC} and ${MAX_BET_TC}.` });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, requestedTelegramId);
  if (!telegramId) {
    return;
  }

  const round = await settleRoundIfNeeded(await ensureRoundForNow());
  const roundLive = getAuthoritativeRoundLiveState(round, Date.now());
  if (roundLive.phase !== "pending") {
    res.status(400).json({ error: "Betting is closed for this round." });
    return;
  }

  try {
    const [bet] = await db.transaction(async (tx) => {
      const [lockedRound] = await tx
        .select()
        .from(crashRoundsTable)
        .where(eq(crashRoundsTable.id, round.id))
        .for("update")
        .limit(1);
      if (!lockedRound) {
        throw new Error("ROUND_NOT_FOUND");
      }

      const live = getAuthoritativeRoundLiveState(lockedRound, Date.now());
      if (live.phase !== "pending") {
        throw new Error("BETTING_CLOSED");
      }

      const [user] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .for("update")
        .limit(1);
      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }
      if ((user.tradeCredits ?? 0) < amountTc) {
        throw new Error("INSUFFICIENT_TC");
      }

      const [alreadyBet] = await tx
        .select({ id: crashBetsTable.id })
        .from(crashBetsTable)
        .where(and(eq(crashBetsTable.roundId, lockedRound.id), eq(crashBetsTable.telegramId, telegramId)))
        .limit(1);
      if (alreadyBet) {
        throw new Error("ALREADY_BET");
      }

      await tx
        .update(usersTable)
        .set({
          tradeCredits: sql`${usersTable.tradeCredits} - ${amountTc}`,
        })
        .where(eq(usersTable.telegramId, telegramId));

      const [createdBet] = await tx
        .insert(crashBetsTable)
        .values({
          roundId: lockedRound.id,
          telegramId,
          amountTc,
          status: "pending",
        })
        .returning();
      return [createdBet];
    });

    logger.info(
      { telegramId, roundId: round.id, amountTc, betId: bet.id },
      "Crash bet placed",
    );
    res.status(201).json(serializeRow(bet as unknown as Record<string, unknown>));
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "ROUND_NOT_FOUND") {
      res.status(404).json({ error: "Round not found." });
      return;
    }
    if (message === "BETTING_CLOSED") {
      res.status(400).json({ error: "Betting is closed for this round." });
      return;
    }
    if (message === "USER_NOT_FOUND") {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (message === "INSUFFICIENT_TC") {
      res.status(400).json({ error: "Insufficient Trade Credits." });
      return;
    }
    if (message === "ALREADY_BET") {
      res.status(400).json({ error: "You already placed a bet in this round." });
      return;
    }
    logger.error({ err, telegramId, amountTc }, "Crash bet placement failed");
    res.status(500).json({ error: "Failed to place crash bet." });
  }
});

router.post("/crash/cashout", crashActionRateLimiter, async (req, res): Promise<void> => {
  const requestedTelegramId = String(req.body?.telegramId ?? "").trim();
  const roundId = Number(req.body?.roundId);

  if (!requestedTelegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  if (!Number.isFinite(roundId)) {
    res.status(400).json({ error: "roundId is required." });
    return;
  }

  const telegramId = resolveAuthenticatedTelegramId(req, res, requestedTelegramId);
  if (!telegramId) return;

  const idempotency = await beginIdempotency(req, {
    scope: "crash.cashout",
    requireHeader: true,
    fingerprintData: { telegramId, roundId },
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
      logger.warn({ err, telegramId, roundId }, "Failed to persist idempotent cashout response");
      await idempotencyHandle.abort();
    }
    res.status(statusCode).json(payload);
  };

  type CashoutOutcome =
    | {
        kind: "success";
        roundId: number;
        cashoutMultiplier: number;
        payoutGc: number;
        bet: CrashBetRow;
      }
    | {
        kind: "already_resolved";
        roundId: number;
        bet: CrashBetRow;
      }
    | {
        kind: "too_late";
        roundId: number;
        crashMultiplier: number;
      }
    | {
        kind: "not_running";
        roundId: number;
        phase: "betting" | "running" | "crashed" | "settled";
      };

  try {
    const outcome = await db.transaction<CashoutOutcome>(async (tx) => {
      const [lockedRound] = await tx
        .select()
        .from(crashRoundsTable)
        .where(eq(crashRoundsTable.id, roundId))
        .for("update")
        .limit(1);
      if (!lockedRound) {
        throw new Error("ROUND_NOT_FOUND");
      }

      const [lockedBet] = await tx
        .select()
        .from(crashBetsTable)
        .where(and(eq(crashBetsTable.roundId, roundId), eq(crashBetsTable.telegramId, telegramId)))
        .for("update")
        .limit(1);
      if (!lockedBet) {
        throw new Error("BET_NOT_FOUND");
      }

      if (lockedBet.status !== "pending") {
        return {
          kind: "already_resolved",
          roundId,
          bet: lockedBet,
        };
      }

      const nowMs = Date.now();
      let live = getAuthoritativeRoundLiveState(lockedRound, nowMs);
      let effectiveRound = lockedRound;
      if (live.phase === "crashed" || live.phase === "settled") {
        effectiveRound = await settleRoundInTransaction(tx, lockedRound, nowMs);
        live = getAuthoritativeRoundLiveState(effectiveRound, nowMs);
      }

      if (live.phase !== "running") {
        if (live.phase === "crashed" || live.phase === "settled") {
          return {
            kind: "too_late",
            roundId,
            crashMultiplier: Number(Math.max(1, effectiveRound.crashMultiplier).toFixed(2)),
          };
        }
        return {
          kind: "not_running",
          roundId,
          phase: toClientPhase(live.phase),
        };
      }

      const [lockedUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .for("update")
        .limit(1);
      if (!lockedUser) {
        throw new Error("USER_NOT_FOUND");
      }

      const payoutGc = Math.floor((lockedBet.amountTc ?? 0) * live.multiplier);
      const [updatedBet] = await tx
        .update(crashBetsTable)
        .set({
          status: "cashed",
          cashoutMultiplier: live.multiplier,
          payoutGc,
          resolvedAt: new Date(),
        })
        .where(and(eq(crashBetsTable.id, lockedBet.id), eq(crashBetsTable.status, "pending")))
        .returning();

      if (!updatedBet) {
        const [resolvedBet] = await tx
          .select()
          .from(crashBetsTable)
          .where(eq(crashBetsTable.id, lockedBet.id))
          .limit(1);
        if (resolvedBet) {
          return { kind: "already_resolved", roundId, bet: resolvedBet };
        }
        throw new Error("BET_RESOLUTION_FAILED");
      }

      await tx
        .update(usersTable)
        .set({
          goldCoins: sql`${usersTable.goldCoins} + ${payoutGc}`,
          totalGcEarned: sql`${usersTable.totalGcEarned} + ${payoutGc}`,
        })
        .where(eq(usersTable.telegramId, telegramId));

      return {
        kind: "success",
        roundId,
        cashoutMultiplier: live.multiplier,
        payoutGc,
        bet: updatedBet,
      };
    });

    if (outcome.kind === "already_resolved") {
      await replyWithCommit(200, {
        roundId: outcome.roundId,
        alreadyResolved: true,
        bet: serializeRow(outcome.bet as unknown as Record<string, unknown>),
      });
      return;
    }
    if (outcome.kind === "too_late") {
      logger.info({ telegramId, roundId }, "Crash cashout rejected: too late");
      await replyWithCommit(400, {
        error: "Too late. Round crashed.",
        crashMultiplier: outcome.crashMultiplier,
      });
      return;
    }
    if (outcome.kind === "not_running") {
      await replyWithCommit(400, {
        error: "Round is not running.",
        phase: outcome.phase,
      });
      return;
    }

    logger.info(
      {
        telegramId,
        roundId,
        betId: outcome.bet.id,
        cashoutMultiplier: outcome.cashoutMultiplier,
        payoutGc: outcome.payoutGc,
      },
      "Crash cashout processed",
    );
    await replyWithCommit(200, {
      roundId: outcome.roundId,
      cashoutMultiplier: outcome.cashoutMultiplier,
      payoutGc: outcome.payoutGc,
      bet: serializeRow(outcome.bet as unknown as Record<string, unknown>),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "ROUND_NOT_FOUND") {
      await replyWithCommit(404, { error: "Round not found." });
      return;
    }
    if (message === "BET_NOT_FOUND") {
      await replyWithCommit(404, { error: "Bet not found." });
      return;
    }
    if (message === "USER_NOT_FOUND") {
      await replyWithCommit(404, { error: "User not found." });
      return;
    }
    logger.error({ err, telegramId, roundId }, "Crash cashout failed");
    await idempotencyHandle.abort();
    res.status(500).json({ error: "Crash cashout failed." });
  }
});

router.get("/crash/history", async (req, res): Promise<void> => {
  const limitRaw = Number(req.query.limit ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 30;
  const rows = await db.select().from(crashRoundsTable).orderBy(desc(crashRoundsTable.id)).limit(limit);
  res.json(serializeRows(rows as unknown as Record<string, unknown>[]));
});

router.get("/crash/bets/:telegramId", async (req, res): Promise<void> => {
  const requestedTelegramId = String(req.params.telegramId ?? "").trim();
  if (!requestedTelegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  const telegramId = resolveAuthenticatedTelegramId(req, res, requestedTelegramId);
  if (!telegramId) return;

  const limitRaw = Number(req.query.limit ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 30;

  const bets = await db
    .select()
    .from(crashBetsTable)
    .where(eq(crashBetsTable.telegramId, telegramId))
    .orderBy(desc(crashBetsTable.id))
    .limit(limit);

  const roundIds = [...new Set(bets.map((bet) => bet.roundId))];
  const rounds = roundIds.length
    ? await db.select().from(crashRoundsTable).where(inArray(crashRoundsTable.id, roundIds))
    : [];
  const roundById = new Map(rounds.map((round) => [round.id, round]));

  const rows = bets.map((bet) => {
    const round = roundById.get(bet.roundId);
    const roundLive = round ? getAuthoritativeRoundLiveState(round) : null;
    return {
      ...bet,
      crashMultiplier: round?.crashMultiplier ?? null,
      roundPhase: roundLive ? toClientPhase(roundLive.phase) : null,
    };
  });

  res.json(serializeRows(rows as unknown as Record<string, unknown>[]));
});

router.post("/crash/settle", async (_req, res): Promise<void> => {
  const [round] = await db.select().from(crashRoundsTable).orderBy(desc(crashRoundsTable.id)).limit(1);
  if (round) {
    await settleRoundIfNeeded(round);
  }
  res.json({ ok: true });
});

export default router;

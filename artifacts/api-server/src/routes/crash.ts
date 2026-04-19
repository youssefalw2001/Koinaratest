import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, crashBetsTable, crashRoundsTable, usersTable } from "@workspace/db";
import {
  BETTING_PHASE_MS,
  CRASH_HOUSE_EDGE,
  createRoundFromStart,
  getCrashMultiplierAtElapsedSec,
  getCurrentRoundStart,
  getRoundCycleMs,
} from "../lib/crashRuntime";
import { serializeRow, serializeRows } from "../lib/serialize";

const router: IRouter = Router();

const MIN_BET_TC = 25;
const MAX_BET_TC = 5000;
const STREAM_TICK_MS = 750;

type CrashRoundRow = typeof crashRoundsTable.$inferSelect;
type CrashStatePayload = {
  houseEdge: number;
  cycleMs: number;
  round: {
    id: number;
    phase: "betting" | "running" | "crashed";
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

type SlidingWindowEntry = { count: number; resetAt: number };

const streamSubscribers = new Set<Response>();
let streamLoop: NodeJS.Timeout | null = null;
let streamTickInFlight = false;

function getClientKey(req: Request): string {
  const forwardedRaw = req.headers["x-forwarded-for"];
  const forwarded = Array.isArray(forwardedRaw)
    ? forwardedRaw[0]
    : forwardedRaw?.split(",")[0]?.trim();
  return forwarded || req.ip || "unknown";
}

function createRateLimiter(windowMs: number, maxRequests: number) {
  const windows = new Map<string, SlidingWindowEntry>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${getClientKey(req)}:${req.path}`;
    const current = windows.get(key);
    if (!current || now > current.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("retry-after", retryAfter.toString());
      res.status(429).json({ error: "Too many requests. Please slow down." });
      return;
    }

    current.count += 1;
    windows.set(key, current);
    next();
  };
}

const crashActionRateLimiter = createRateLimiter(10_000, 12);

function getRoundPhase(round: CrashRoundRow, nowMs = Date.now()): "betting" | "running" | "crashed" {
  const bettingClosesAtMs = new Date(round.bettingClosesAt).getTime();
  const runningStartedAtMs = new Date(round.runningStartedAt).getTime();
  const crashAtMs = new Date(round.crashAt).getTime();
  const elapsedRunningSec = Math.max(0, (nowMs - runningStartedAtMs) / 1000);
  const liveMultiplier = getCrashMultiplierAtElapsedSec(elapsedRunningSec);
  if (round.phase === "crashed" || nowMs >= crashAtMs) return "crashed";
  if (liveMultiplier >= round.crashMultiplier) return "crashed";
  if (nowMs >= bettingClosesAtMs) return "running";
  return "betting";
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
      phase: "betting",
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

async function settleRoundIfNeeded(round: CrashRoundRow): Promise<CrashRoundRow> {
  if (getRoundPhase(round) !== "crashed") return round;
  if (round.phase === "crashed") return round;

  await db.transaction(async (tx) => {
    const pendingBets = await tx
      .select()
      .from(crashBetsTable)
      .where(and(eq(crashBetsTable.roundId, round.id), eq(crashBetsTable.status, "pending")));

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

    await tx
      .update(crashRoundsTable)
      .set({ phase: "crashed" })
      .where(eq(crashRoundsTable.id, round.id));
  });

  const [updated] = await db.select().from(crashRoundsTable).where(eq(crashRoundsTable.id, round.id)).limit(1);
  return updated ?? round;
}

async function buildCrashStatePayload(): Promise<CrashStatePayload> {
  const round = await ensureRoundForNow();
  const settledRound = await settleRoundIfNeeded(round);

  const nowMs = Date.now();
  const phase = getRoundPhase(settledRound, nowMs);
  const elapsedSec = Math.max(0, (nowMs - new Date(settledRound.runningStartedAt).getTime()) / 1000);
  const projectedMultiplier = getCrashMultiplierAtElapsedSec(elapsedSec);
  const liveMultiplier = phase === "crashed" ? settledRound.crashMultiplier : projectedMultiplier;

  if (phase !== settledRound.phase) {
    await db.update(crashRoundsTable).set({ phase }).where(eq(crashRoundsTable.id, settledRound.id));
  }

  return {
    houseEdge: CRASH_HOUSE_EDGE,
    cycleMs: getRoundCycleMs(),
    round: {
      id: settledRound.id,
      phase,
      bettingOpensAt: new Date(settledRound.bettingOpensAt).toISOString(),
      bettingClosesAt: new Date(settledRound.bettingClosesAt).toISOString(),
      runningStartedAt: new Date(settledRound.runningStartedAt).toISOString(),
      crashAt: new Date(settledRound.crashAt).toISOString(),
      crashMultiplier: settledRound.crashMultiplier,
      seedHash: settledRound.seedHash,
      revealedSeed: phase === "crashed" ? settledRound.revealedSeed : null,
    },
    live: {
      elapsedSec: Number(elapsedSec.toFixed(3)),
      multiplier: liveMultiplier,
      crashed: phase === "crashed",
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
  const telegramId = String(req.body?.telegramId ?? "").trim();
  const amountTc = Number(req.body?.amountTc);

  if (!telegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  if (!Number.isFinite(amountTc) || amountTc % 1 !== 0 || amountTc < MIN_BET_TC || amountTc > MAX_BET_TC) {
    res.status(400).json({ error: `amountTc must be an integer between ${MIN_BET_TC} and ${MAX_BET_TC}.` });
    return;
  }

  const round = await settleRoundIfNeeded(await ensureRoundForNow());
  const phase = getRoundPhase(round);
  if (phase !== "betting") {
    res.status(400).json({ error: "Betting is closed for this round." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, telegramId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if ((user.tradeCredits ?? 0) < amountTc) {
    res.status(400).json({ error: "Insufficient Trade Credits." });
    return;
  }

  const [alreadyBet] = await db
    .select({ id: crashBetsTable.id })
    .from(crashBetsTable)
    .where(and(eq(crashBetsTable.roundId, round.id), eq(crashBetsTable.telegramId, telegramId)))
    .limit(1);
  if (alreadyBet) {
    res.status(400).json({ error: "You already placed a bet in this round." });
    return;
  }

  const [bet] = await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({
        tradeCredits: sql`${usersTable.tradeCredits} - ${amountTc}`,
      })
      .where(eq(usersTable.telegramId, telegramId));

    const [createdBet] = await tx
      .insert(crashBetsTable)
      .values({
        roundId: round.id,
        telegramId,
        amountTc,
        status: "pending",
      })
      .returning();
    return [createdBet];
  });

  res.status(201).json(serializeRow(bet as unknown as Record<string, unknown>));
});

router.post("/crash/cashout", crashActionRateLimiter, async (req, res): Promise<void> => {
  const telegramId = String(req.body?.telegramId ?? "").trim();
  const roundId = Number(req.body?.roundId);

  if (!telegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
  if (!Number.isFinite(roundId)) {
    res.status(400).json({ error: "roundId is required." });
    return;
  }

  const [round] = await db.select().from(crashRoundsTable).where(eq(crashRoundsTable.id, roundId)).limit(1);
  if (!round) {
    res.status(404).json({ error: "Round not found." });
    return;
  }

  const settledRound = await settleRoundIfNeeded(round);
  const phase = getRoundPhase(settledRound);
  if (phase !== "running") {
    res.status(400).json({ error: "Round is not running." });
    return;
  }

  const [bet] = await db
    .select()
    .from(crashBetsTable)
    .where(and(eq(crashBetsTable.roundId, roundId), eq(crashBetsTable.telegramId, telegramId)))
    .limit(1);
  if (!bet) {
    res.status(404).json({ error: "Bet not found." });
    return;
  }
  if (bet.status !== "pending") {
    res.status(400).json({ error: "Bet already resolved." });
    return;
  }

  const elapsedSec = Math.max(0, (Date.now() - new Date(settledRound.runningStartedAt).getTime()) / 1000);
  const currentMultiplier = getCrashMultiplierAtElapsedSec(elapsedSec);
  if (currentMultiplier >= settledRound.crashMultiplier) {
    await settleRoundIfNeeded(settledRound);
    res.status(400).json({ error: "Too late. Round crashed." });
    return;
  }

  const payoutGc = Math.floor((bet.amountTc ?? 0) * currentMultiplier);
  const [updatedBet] = await db.transaction(async (tx) => {
    const [saved] = await tx
      .update(crashBetsTable)
      .set({
        status: "cashed",
        cashoutMultiplier: currentMultiplier,
        payoutGc,
        resolvedAt: new Date(),
      })
      .where(eq(crashBetsTable.id, bet.id))
      .returning();

    await tx
      .update(usersTable)
      .set({
        goldCoins: sql`${usersTable.goldCoins} + ${payoutGc}`,
        totalGcEarned: sql`${usersTable.totalGcEarned} + ${payoutGc}`,
      })
      .where(eq(usersTable.telegramId, telegramId));

    return [saved];
  });

  res.json({
    roundId,
    cashoutMultiplier: currentMultiplier,
    payoutGc,
    bet: serializeRow(updatedBet as unknown as Record<string, unknown>),
  });
});

router.get("/crash/history", async (req, res): Promise<void> => {
  const limitRaw = Number(req.query.limit ?? 30);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 30;
  const rows = await db.select().from(crashRoundsTable).orderBy(desc(crashRoundsTable.id)).limit(limit);
  res.json(serializeRows(rows as unknown as Record<string, unknown>[]));
});

router.get("/crash/bets/:telegramId", async (req, res): Promise<void> => {
  const telegramId = String(req.params.telegramId ?? "").trim();
  if (!telegramId) {
    res.status(400).json({ error: "telegramId is required." });
    return;
  }
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
    return {
      ...bet,
      crashMultiplier: round?.crashMultiplier ?? null,
      roundPhase: round ? getRoundPhase(round) : null,
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

import { Router, type IRouter } from "express";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { battlesTable, db, usersTable } from "@workspace/db";
import { battleCapStatus, battleConstants, battleInput, createOrJoinBattle, publicBattle, resolveBattleByCode } from "../lib/battleLogic";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { isVipActive } from "../lib/vip";

const router: IRouter = Router();

function maskName(row: { username?: string | null; firstName?: string | null; telegramId?: string | null }): string {
  const raw = row.username ? `@${row.username}` : row.firstName || `user${String(row.telegramId ?? "000").slice(-3)}`;
  if (raw.startsWith("@")) return `${raw.slice(0, 5)}***`;
  return raw.length <= 3 ? `${raw}***` : `${raw.slice(0, 3)}***`;
}

function canRevealOpponent(row: typeof battlesTable.$inferSelect, viewerTelegramId: string, vip: boolean): boolean {
  if (!vip || row.status !== "active" || !row.startedAt) return false;
  const elapsed = Date.now() - row.startedAt.getTime();
  return elapsed >= battleConstants.BATTLE_DURATION_MS - 10_000;
}

function battleForViewer(row: typeof battlesTable.$inferSelect, viewerTelegramId: string, vip = false) {
  const base = publicBattle(row, viewerTelegramId) as Record<string, unknown>;
  if (canRevealOpponent(row, viewerTelegramId, vip)) {
    base.opponentPrediction = row.player1TelegramId === viewerTelegramId ? row.player2Prediction : row.player1Prediction;
  }
  return base;
}

router.post("/battles/create", async (req, res): Promise<void> => {
  const telegramId = String(req.body?.telegramId ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  try {
    const result = await createOrJoinBattle({
      telegramId: authedId,
      stakeTc: req.body?.stakeTc,
      prediction: req.body?.prediction,
      battleType: req.body?.battleType,
      symbol: req.body?.symbol,
    });
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "INVALID_BATTLE_INPUT") { res.status(400).json({ error: "Choose a valid stake and UP/DOWN prediction." }); return; }
    if (message === "OPEN_BATTLE_EXISTS") { res.status(409).json({ error: "You already have an open battle. Finish or cancel it first." }); return; }
    if (message === "USER_NOT_FOUND") { res.status(404).json({ error: "User not found." }); return; }
    if (message === "STAKE_LIMIT") { res.status(400).json({ error: "Free users can stake up to 1,000 TC. VIP unlocks 5,000 TC battles." }); return; }
    if (message === "INSUFFICIENT_TC") { res.status(400).json({ error: "Insufficient TC." }); return; }
    if (message === "LIVE_PRICE_UNAVAILABLE") { res.status(503).json({ error: "Live BTC price is unavailable. Try again in a moment." }); return; }
    if (message === "SELF_BATTLE_BLOCKED") { res.status(400).json({ error: "You cannot battle yourself." }); return; }
    if (message === "COORDINATION_LIMIT") { res.status(429).json({ error: "Too many battles with the same opponent. Try a different match." }); return; }
    res.status(500).json({ error: "Failed to create battle." });
  }
});

router.post("/battles/cancel", async (req, res): Promise<void> => {
  const telegramId = String(req.body?.telegramId ?? "");
  const battleCode = String(req.body?.battleCode ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  if (!battleCode) { res.status(400).json({ error: "Missing battle code." }); return; }

  try {
    const [cancelled] = await db.transaction(async (tx) => {
      const [battle] = await tx.select().from(battlesTable).where(eq(battlesTable.battleCode, battleCode)).for("update").limit(1);
      if (!battle) throw new Error("NOT_FOUND");
      if (battle.player1TelegramId !== authedId || battle.status !== "waiting") throw new Error("NOT_CANCELABLE");
      const elapsed = Date.now() - battle.createdAt.getTime();
      if (elapsed > 60_000) throw new Error("CANCEL_WINDOW_CLOSED");
      await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${battle.stakeTc}` }).where(eq(usersTable.telegramId, authedId));
      return tx.update(battlesTable).set({ status: "cancelled", refundedTc: battle.stakeTc, resolvedAt: new Date() }).where(eq(battlesTable.id, battle.id)).returning();
    });
    res.json({ battle: cancelled ? battleForViewer(cancelled, authedId) : null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "UNKNOWN";
    if (message === "NOT_FOUND") { res.status(404).json({ error: "Battle not found." }); return; }
    if (message === "NOT_CANCELABLE") { res.status(400).json({ error: "This battle cannot be cancelled." }); return; }
    if (message === "CANCEL_WINDOW_CLOSED") { res.status(400).json({ error: "Cancel window closed. Waiting battles auto-expire after 5 minutes." }); return; }
    res.status(500).json({ error: "Failed to cancel battle." });
  }
});

router.get("/battles/waiting/:stakeTc", async (req, res): Promise<void> => {
  const stakeTc = battleInput.normalizeStake(req.params.stakeTc);
  if (!stakeTc) { res.status(400).json({ error: "Invalid stake." }); return; }
  const rows = await db.select({ id: battlesTable.id }).from(battlesTable).where(and(eq(battlesTable.status, "waiting"), eq(battlesTable.stakeTc, stakeTc), eq(battlesTable.battleType, "quick")));
  res.json({ stakeTc, waiting: rows.length });
});

router.get("/battles/active", async (req, res): Promise<void> => {
  const telegramId = String(req.query.telegramId ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  const vip = user ? isVipActive(user) : false;
  const [battle] = await db
    .select()
    .from(battlesTable)
    .where(and(or(eq(battlesTable.player1TelegramId, authedId), eq(battlesTable.player2TelegramId, authedId)), or(eq(battlesTable.status, "waiting"), eq(battlesTable.status, "active"), eq(battlesTable.status, "resolving"))))
    .orderBy(desc(battlesTable.createdAt))
    .limit(1);
  res.json({ battle: battle ? battleForViewer(battle, authedId, vip) : null, cap: user ? battleCapStatus(user) : null });
});

router.get("/battles/status/:battleCode", async (req, res): Promise<void> => {
  const telegramId = String(req.query.telegramId ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  const [battle] = await db.select().from(battlesTable).where(eq(battlesTable.battleCode, String(req.params.battleCode))).limit(1);
  if (!battle || (battle.player1TelegramId !== authedId && battle.player2TelegramId !== authedId)) {
    res.status(404).json({ error: "Battle not found." });
    return;
  }
  res.json({ battle: battleForViewer(battle, authedId, user ? isVipActive(user) : false), cap: user ? battleCapStatus(user) : null });
});

router.post("/battles/resolve", async (req, res): Promise<void> => {
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (secret && req.header("x-internal-secret") !== secret) { res.status(401).json({ error: "Unauthorized" }); return; }
  const battleCode = String(req.body?.battleCode ?? "");
  if (!battleCode) { res.status(400).json({ error: "Missing battleCode." }); return; }
  const battle = await resolveBattleByCode(battleCode);
  res.json({ battle: battle ? publicBattle(battle) : null });
});

router.get("/battles/recent", async (req, res): Promise<void> => {
  const telegramId = String(req.query.telegramId ?? "");
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;
  const rows = await db
    .select()
    .from(battlesTable)
    .where(and(or(eq(battlesTable.player1TelegramId, authedId), eq(battlesTable.player2TelegramId, authedId)), or(eq(battlesTable.status, "resolved"), eq(battlesTable.status, "draw"), eq(battlesTable.status, "cancelled"))))
    .orderBy(desc(battlesTable.resolvedAt))
    .limit(10);
  res.json({
    battles: rows.map((row) => {
      const won = row.winnerTelegramId === authedId;
      const isPlayer1 = row.player1TelegramId === authedId;
      const opponent = isPlayer1 ? row.player2TelegramId : row.player1TelegramId;
      return {
        battleCode: row.battleCode,
        result: row.status === "draw" ? "draw" : row.status === "cancelled" ? "cancelled" : won ? "win" : "loss",
        opponentMasked: opponent ? `@user***${opponent.slice(-3)}` : "—",
        stakeTc: row.stakeTc,
        gcEarned: won ? row.gcPayout : 0,
        refundedTc: row.refundedTc,
        startPrice: row.startPrice,
        endPrice: row.endPrice,
        resolvedAt: row.resolvedAt?.toISOString() ?? row.createdAt.toISOString(),
      };
    }),
  });
});

router.get("/battles/leaderboard", async (_req, res): Promise<void> => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ winnerTelegramId: battlesTable.winnerTelegramId, totalGc: sql<number>`coalesce(sum(${battlesTable.gcPayout}), 0)` })
    .from(battlesTable)
    .where(and(eq(battlesTable.status, "resolved"), eq(battlesTable.isDraw, false), sql`${battlesTable.resolvedAt} >= ${since}`))
    .groupBy(battlesTable.winnerTelegramId)
    .orderBy(sql`coalesce(sum(${battlesTable.gcPayout}), 0) desc`)
    .limit(10);

  const users = await db.select({ telegramId: usersTable.telegramId, username: usersTable.username, firstName: usersTable.firstName }).from(usersTable).where(sql`${usersTable.telegramId} in ${rows.map((r) => r.winnerTelegramId).filter(Boolean)}`);
  const userMap = new Map(users.map((u) => [u.telegramId, u]));
  res.json({ leaderboard: rows.filter((r) => r.winnerTelegramId).map((row, index) => ({ rank: index + 1, name: maskName(userMap.get(row.winnerTelegramId!) ?? { telegramId: row.winnerTelegramId }), totalGc: Number(row.totalGc ?? 0) })) });
});

export default router;

import { and, count, eq, gte, lte, or, sql } from "drizzle-orm";
import { battlesTable, db, usersTable } from "@workspace/db";
import { getSymbolPrice, type SupportedSymbol } from "./btcPriceCache";
import { isVipActive } from "./vip";
import { logger } from "./logger";

export type BattlePrediction = "up" | "down";
export type BattleType = "quick" | "private";

export const BATTLE_STAKES = [50, 100, 250, 500, 1000, 5000] as const;
const SUPPORTED_BATTLE_SYMBOLS: SupportedSymbol[] = ["BTCUSDT"];
const FREE_MAX_STAKE_TC = 1000;
const VIP_MAX_STAKE_TC = 5000;
const FREE_DAILY_BATTLE_GC_CAP = 5000;
const VIP_DAILY_BATTLE_GC_CAP = 15000;
const BATTLE_DURATION_MS = 60_000;
const WAITING_EXPIRY_MS = 5 * 60_000;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "BATTLE-";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function normalizeSymbol(raw: unknown): SupportedSymbol {
  const symbol = typeof raw === "string" ? raw.toUpperCase().replace(/[^A-Z0-9]/g, "") : "BTCUSDT";
  return SUPPORTED_BATTLE_SYMBOLS.includes(symbol as SupportedSymbol) ? (symbol as SupportedSymbol) : "BTCUSDT";
}

function normalizePrediction(raw: unknown): BattlePrediction | null {
  return raw === "up" || raw === "down" ? raw : null;
}

function normalizeBattleType(raw: unknown): BattleType {
  return raw === "private" ? "private" : "quick";
}

function normalizeStake(raw: unknown): number | null {
  const stake = Number(raw);
  return BATTLE_STAKES.includes(stake as (typeof BATTLE_STAKES)[number]) ? stake : null;
}

async function livePrice(symbol: SupportedSymbol): Promise<number> {
  const price = await getSymbolPrice(symbol);
  if (!price || !Number.isFinite(price) || price <= 0) throw new Error("LIVE_PRICE_UNAVAILABLE");
  return Math.trunc(price * 100) / 100;
}

async function ensureNoOpenBattle(telegramId: string): Promise<void> {
  const open = await db
    .select({ id: battlesTable.id })
    .from(battlesTable)
    .where(
      and(
        or(eq(battlesTable.player1TelegramId, telegramId), eq(battlesTable.player2TelegramId, telegramId)),
        or(eq(battlesTable.status, "waiting"), eq(battlesTable.status, "active"), eq(battlesTable.status, "resolving")),
      ),
    )
    .limit(1);
  if (open.length > 0) throw new Error("OPEN_BATTLE_EXISTS");
}

async function ensureCoordinationAllowed(playerA: string, playerB: string): Promise<void> {
  if (playerA === playerB) throw new Error("SELF_BATTLE_BLOCKED");
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await db
    .select({ cnt: count() })
    .from(battlesTable)
    .where(
      and(
        gte(battlesTable.createdAt, since),
        or(
          and(eq(battlesTable.player1TelegramId, playerA), eq(battlesTable.player2TelegramId, playerB)),
          and(eq(battlesTable.player1TelegramId, playerB), eq(battlesTable.player2TelegramId, playerA)),
        ),
      ),
    );
  if ((rows[0]?.cnt ?? 0) >= 5) throw new Error("COORDINATION_LIMIT");
}

function serializeBattle(row: typeof battlesTable.$inferSelect) {
  return {
    ...row,
    startedAt: row.startedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function publicBattle(row: typeof battlesTable.$inferSelect, viewerTelegramId?: string | null) {
  const battle = serializeBattle(row);
  const isPlayer1 = viewerTelegramId && row.player1TelegramId === viewerTelegramId;
  const isPlayer2 = viewerTelegramId && row.player2TelegramId === viewerTelegramId;
  const opponentTelegramId = isPlayer1 ? row.player2TelegramId : isPlayer2 ? row.player1TelegramId : null;
  // Reveal opponent's prediction once the battle is over (resolved, draw, or cancelled).
  // During active/waiting/resolving it stays hidden to prevent peeking.
  const settled = row.status === "resolved" || row.status === "draw" || row.status === "cancelled";
  const opponentPrediction = settled
    ? (isPlayer1 ? row.player2Prediction : isPlayer2 ? row.player1Prediction : null)
    : null;
  return {
    ...battle,
    viewerPrediction: isPlayer1 ? row.player1Prediction : isPlayer2 ? row.player2Prediction : null,
    opponentPrediction,
    opponentMasked: opponentTelegramId ? `@user***${opponentTelegramId.slice(-3)}` : null,
    player1TelegramId: undefined,
    player2TelegramId: undefined,
  };
}

export async function createOrJoinBattle(input: {
  telegramId: string;
  stakeTc: unknown;
  prediction: unknown;
  battleType?: unknown;
  symbol?: unknown;
}) {
  const stakeTc = normalizeStake(input.stakeTc);
  const prediction = normalizePrediction(input.prediction);
  const battleType = normalizeBattleType(input.battleType);
  const symbol = normalizeSymbol(input.symbol);
  if (!stakeTc || !prediction) throw new Error("INVALID_BATTLE_INPUT");

  await ensureNoOpenBattle(input.telegramId);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, input.telegramId)).limit(1);
  if (!user) throw new Error("USER_NOT_FOUND");
  const vip = isVipActive(user);
  const maxStake = vip ? VIP_MAX_STAKE_TC : FREE_MAX_STAKE_TC;
  if (stakeTc > maxStake) throw new Error("STAKE_LIMIT");
  if ((user.tradeCredits ?? 0) < stakeTc) throw new Error("INSUFFICIENT_TC");

  if (battleType === "quick") {
    const waiting = await db
      .select()
      .from(battlesTable)
      .where(and(eq(battlesTable.status, "waiting"), eq(battlesTable.battleType, "quick"), eq(battlesTable.stakeTc, stakeTc), gte(battlesTable.expiresAt, new Date())))
      .orderBy(battlesTable.createdAt)
      .limit(5);

    const candidate = waiting.find((row) => row.player1TelegramId !== input.telegramId);
    if (candidate) {
      await ensureCoordinationAllowed(candidate.player1TelegramId, input.telegramId);
      const startPrice = await livePrice(symbol);
      const joined = await db.transaction(async (tx) => {
        const [deducted] = await tx
          .update(usersTable)
          .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${stakeTc}` })
          .where(and(eq(usersTable.telegramId, input.telegramId), gte(usersTable.tradeCredits, stakeTc)))
          .returning({ telegramId: usersTable.telegramId });
        if (!deducted) throw new Error("INSUFFICIENT_TC");

        const [updated] = await tx
          .update(battlesTable)
          .set({
            player2TelegramId: input.telegramId,
            player2Prediction: prediction,
            status: "active",
            startPrice,
            startedAt: new Date(),
          })
          .where(and(eq(battlesTable.id, candidate.id), eq(battlesTable.status, "waiting")))
          .returning();
        if (!updated) throw new Error("BATTLE_MATCH_RACE");
        return updated;
      });
      logger.info({ battleCode: joined.battleCode, stakeTc, type: "quick" }, "Battle matched and started");
      return { battle: publicBattle(joined, input.telegramId), matched: true };
    }
  }

  const startPrice = await livePrice(symbol);
  const battleCode = randomCode();
  const expiresAt = new Date(Date.now() + WAITING_EXPIRY_MS);
  const created = await db.transaction(async (tx) => {
    const [deducted] = await tx
      .update(usersTable)
      .set({ tradeCredits: sql`${usersTable.tradeCredits} - ${stakeTc}` })
      .where(and(eq(usersTable.telegramId, input.telegramId), gte(usersTable.tradeCredits, stakeTc)))
      .returning({ telegramId: usersTable.telegramId });
    if (!deducted) throw new Error("INSUFFICIENT_TC");

    const [inserted] = await tx
      .insert(battlesTable)
      .values({
        battleCode,
        player1TelegramId: input.telegramId,
        stakeTc,
        player1Prediction: prediction,
        status: "waiting",
        battleType,
        symbol,
        startPrice,
        expiresAt,
      })
      .returning();
    if (!inserted) throw new Error("BATTLE_CREATE_FAILED");
    return inserted;
  });

  logger.info({ battleCode: created.battleCode, stakeTc, type: battleType }, "Battle waiting created");
  return { battle: publicBattle(created, input.telegramId), matched: false };
}

export async function resolveBattleByCode(battleCode: string) {
  const reserved = await db.transaction(async (tx) => {
    const [battle] = await tx.select().from(battlesTable).where(eq(battlesTable.battleCode, battleCode)).for("update").limit(1);
    if (!battle) return null;
    if (battle.status !== "active") return battle;
    if (!battle.startedAt || battle.startedAt.getTime() + BATTLE_DURATION_MS > Date.now()) return battle;
    if (!battle.player2TelegramId || !battle.startPrice || !battle.player1Prediction || !battle.player2Prediction) return battle;

    const [locked] = await tx.update(battlesTable).set({ status: "resolving" }).where(and(eq(battlesTable.id, battle.id), eq(battlesTable.status, "active"))).returning();
    return locked ?? battle;
  });

  if (!reserved) return null;
  if (reserved.status !== "resolving") return reserved;
  if (!reserved.player2TelegramId || !reserved.startPrice || !reserved.player1Prediction || !reserved.player2Prediction) return reserved;

  let endPrice: number;
  try {
    endPrice = await livePrice(normalizeSymbol(reserved.symbol));
  } catch (err) {
    logger.warn({ err, battleCode }, "Battle price unavailable during resolution; retrying later");
    const [restored] = await db.update(battlesTable).set({ status: "active" }).where(and(eq(battlesTable.battleCode, battleCode), eq(battlesTable.status, "resolving"))).returning();
    return restored ?? reserved;
  }

  const side: BattlePrediction | "draw" = endPrice > reserved.startPrice ? "up" : endPrice < reserved.startPrice ? "down" : "draw";
  const isDraw = side === "draw" || reserved.player1Prediction === reserved.player2Prediction;
  const rake = reserved.battleType === "private" ? 0.15 : 0.10;

  return db.transaction(async (tx) => {
    const [battle] = await tx.select().from(battlesTable).where(eq(battlesTable.battleCode, battleCode)).for("update").limit(1);
    if (!battle || battle.status !== "resolving") return battle ?? null;

    if (isDraw) {
      const refundEach = Math.floor(battle.stakeTc * 0.95);
      const houseTcKept = battle.stakeTc * 2 - refundEach * 2;
      await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${refundEach}` }).where(or(eq(usersTable.telegramId, battle.player1TelegramId), eq(usersTable.telegramId, battle.player2TelegramId ?? "")));
      const [updated] = await tx.update(battlesTable).set({
        status: "draw",
        endPrice,
        isDraw: true,
        refundedTc: refundEach,
        houseTcKept,
        resolvedAt: new Date(),
      }).where(eq(battlesTable.id, battle.id)).returning();
      logger.info({ battleCode, houseTcKept, refundEach }, "Battle resolved as draw");
      return updated ?? battle;
    }

    const winnerTelegramId = battle.player1Prediction === side ? battle.player1TelegramId : battle.player2TelegramId!;
    const [winner] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, winnerTelegramId)).for("update").limit(1);
    const vip = winner ? isVipActive(winner) : false;
    const today = todayStr();
    const currentBattleGc = winner?.dailyBattleGcDate === today ? (winner.dailyBattleGcEarned ?? 0) : 0;
    const cap = vip ? VIP_DAILY_BATTLE_GC_CAP : FREE_DAILY_BATTLE_GC_CAP;
    const remaining = Math.max(0, cap - currentBattleGc);
    const rawPayout = Math.floor(battle.stakeTc * 2 * (1 - rake));
    const gcPayout = Math.min(rawPayout, remaining);

    if (winner && gcPayout > 0) {
      await tx.update(usersTable).set({
        goldCoins: sql`${usersTable.goldCoins} + ${gcPayout}`,
        totalGcEarned: sql`${usersTable.totalGcEarned} + ${gcPayout}`,
        dailyBattleGcEarned: currentBattleGc + gcPayout,
        dailyBattleGcDate: today,
      }).where(eq(usersTable.telegramId, winnerTelegramId));
    }

    const [updated] = await tx.update(battlesTable).set({
      status: "resolved",
      endPrice,
      winnerTelegramId,
      gcPayout,
      houseTcKept: Math.floor(battle.stakeTc * 2 * rake),
      resolvedAt: new Date(),
    }).where(eq(battlesTable.id, battle.id)).returning();
    logger.info({ battleCode, winnerTelegramId, rawPayout, gcPayout, capRemaining: remaining }, "Battle resolved with winner");
    return updated ?? battle;
  });
}

export async function cancelExpiredWaitingBattles(): Promise<number> {
  const expired = await db.select().from(battlesTable).where(and(eq(battlesTable.status, "waiting"), lte(battlesTable.expiresAt, new Date()))).limit(50);
  let cancelled = 0;
  for (const battle of expired) {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(battlesTable).where(eq(battlesTable.id, battle.id)).for("update").limit(1);
      if (!locked || locked.status !== "waiting") return;
      await tx.update(usersTable).set({ tradeCredits: sql`${usersTable.tradeCredits} + ${locked.stakeTc}` }).where(eq(usersTable.telegramId, locked.player1TelegramId));
      await tx.update(battlesTable).set({ status: "cancelled", refundedTc: locked.stakeTc, resolvedAt: new Date() }).where(eq(battlesTable.id, locked.id));
      cancelled += 1;
      logger.info({ battleCode: locked.battleCode, stakeTc: locked.stakeTc }, "Expired waiting battle cancelled and refunded");
    });
  }
  return cancelled;
}

export async function restoreStuckResolvingBattles(): Promise<number> {
  const staleBefore = new Date(Date.now() - 2 * 60_000);
  const restored = await db.update(battlesTable).set({ status: "active" }).where(and(eq(battlesTable.status, "resolving"), lte(battlesTable.startedAt, staleBefore))).returning({ battleCode: battlesTable.battleCode });
  if (restored.length > 0) logger.warn({ count: restored.length }, "Restored stuck resolving battles for retry");
  return restored.length;
}

export async function resolveDueBattles(): Promise<number> {
  const dueBefore = new Date(Date.now() - BATTLE_DURATION_MS);
  const due = await db.select({ battleCode: battlesTable.battleCode }).from(battlesTable).where(and(eq(battlesTable.status, "active"), lte(battlesTable.startedAt, dueBefore))).limit(50);
  let resolved = 0;
  for (const row of due) {
    try {
      const result = await resolveBattleByCode(row.battleCode);
      if (result?.status === "resolved" || result?.status === "draw") resolved += 1;
    } catch (err) {
      logger.warn({ err, battleCode: row.battleCode }, "Battle auto-resolve skipped");
    }
  }
  return resolved;
}

export function battleCapStatus(user: { isVip: boolean; vipExpiresAt: Date | null; vipTrialExpiresAt: Date | null; dailyBattleGcEarned?: number | null; dailyBattleGcDate?: string | null }) {
  const today = todayStr();
  const vip = isVipActive(user);
  const cap = vip ? VIP_DAILY_BATTLE_GC_CAP : FREE_DAILY_BATTLE_GC_CAP;
  const earned = user.dailyBattleGcDate === today ? (user.dailyBattleGcEarned ?? 0) : 0;
  return { earned, cap, remaining: Math.max(0, cap - earned), vip };
}

export const battleInput = { normalizeStake, normalizePrediction, normalizeBattleType, normalizeSymbol };
export const battleConstants = { FREE_MAX_STAKE_TC, VIP_MAX_STAKE_TC, BATTLE_DURATION_MS, WAITING_EXPIRY_MS };

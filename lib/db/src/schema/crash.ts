import { pgTable, serial, text, integer, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const crashRoundsTable = pgTable("crash_rounds", {
  id: serial("id").primaryKey(),
  phase: text("phase").notNull().default("betting"), // betting | running | crashed
  houseEdge: real("house_edge").notNull().default(0.12),
  seedHash: text("seed_hash").notNull(),
  revealedSeed: text("revealed_seed").notNull(),
  crashMultiplier: real("crash_multiplier").notNull(),
  bettingOpensAt: timestamp("betting_opens_at", { withTimezone: true }).notNull(),
  bettingClosesAt: timestamp("betting_closes_at", { withTimezone: true }).notNull(),
  runningStartedAt: timestamp("running_started_at", { withTimezone: true }).notNull(),
  crashAt: timestamp("crash_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crashBetsTable = pgTable(
  "crash_bets",
  {
    id: serial("id").primaryKey(),
    roundId: integer("round_id").notNull(),
    telegramId: text("telegram_id").notNull(),
    amountTc: integer("amount_tc").notNull(),
    status: text("status").notNull().default("pending"), // pending | cashed | lost
    cashoutMultiplier: real("cashout_multiplier"),
    payoutGc: integer("payout_gc").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    roundTelegramUnique: uniqueIndex("crash_bets_round_telegram_unique").on(table.roundId, table.telegramId),
  }),
);

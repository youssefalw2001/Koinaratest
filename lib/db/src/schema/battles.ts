import { pgTable, text, serial, timestamp, integer, real, boolean, index } from "drizzle-orm/pg-core";

export const battlesTable = pgTable("battles", {
  id: serial("id").primaryKey(),
  battleCode: text("battle_code").notNull().unique(),
  player1TelegramId: text("player1_telegram_id").notNull(),
  player2TelegramId: text("player2_telegram_id"),
  stakeTc: integer("stake_tc").notNull(),
  player1Prediction: text("player1_prediction"),
  player2Prediction: text("player2_prediction"),
  status: text("status").notNull().default("waiting"),
  battleType: text("battle_type").notNull().default("quick"),
  symbol: text("symbol").notNull().default("BTCUSDT"),
  startPrice: real("start_price"),
  endPrice: real("end_price"),
  winnerTelegramId: text("winner_telegram_id"),
  gcPayout: integer("gc_payout").notNull().default(0),
  refundedTc: integer("refunded_tc").notNull().default(0),
  houseTcKept: integer("house_tc_kept").notNull().default(0),
  isDraw: boolean("is_draw").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_battles_code").on(table.battleCode),
  index("idx_battles_status").on(table.status),
  index("idx_battles_player1").on(table.player1TelegramId),
  index("idx_battles_player2").on(table.player2TelegramId),
  index("idx_battles_created_at").on(table.createdAt),
  index("idx_battles_waiting_match").on(table.status, table.battleType, table.stakeTc, table.expiresAt),
  index("idx_battles_active_started").on(table.status, table.startedAt),
  index("idx_battles_waiting_expiry").on(table.status, table.expiresAt),
  index("idx_battles_resolved_week").on(table.status, table.resolvedAt),
]);

export type Battle = typeof battlesTable.$inferSelect;

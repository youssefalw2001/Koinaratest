import { pgTable, text, serial, timestamp, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";

export const alphaMarketsTable = pgTable("alpha_markets", {
  id: serial("id").primaryKey(),
  marketId: text("market_id").notNull().unique(),
  symbol: text("symbol").notNull().default("BTCUSDT"),
  durationSec: integer("duration_sec").notNull(),
  question: text("question").notNull(),
  openPrice: real("open_price").notNull(),
  closePrice: real("close_price"),
  resultSide: text("result_side"),
  status: text("status").notNull().default("open"),
  yesPoolTc: integer("yes_pool_tc").notNull().default(0),
  noPoolTc: integer("no_pool_tc").notNull().default(0),
  entryCount: integer("entry_count").notNull().default(0),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("idx_alpha_markets_market_id").on(table.marketId),
  index("idx_alpha_markets_status").on(table.status),
  index("idx_alpha_markets_end_at").on(table.endAt),
]);

export const alphaMarketEntriesTable = pgTable("alpha_market_entries", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  marketId: text("market_id").notNull(),
  symbol: text("symbol").notNull().default("BTCUSDT"),
  side: text("side").notNull(),
  amountTc: integer("amount_tc").notNull(),
  openPrice: real("open_price").notNull(),
  closePrice: real("close_price"),
  status: text("status").notNull().default("open"),
  payoutGc: integer("payout_gc").notNull().default(0),
  alphaPoints: integer("alpha_points").notNull().default(0),
  powerUp: text("power_up"),
  durationSec: integer("duration_sec").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  index("idx_alpha_market_entries_telegram_id").on(table.telegramId),
  index("idx_alpha_market_entries_market_id").on(table.marketId),
  index("idx_alpha_market_entries_status").on(table.status),
]);

export type AlphaMarket = typeof alphaMarketsTable.$inferSelect;
export type AlphaMarketEntry = typeof alphaMarketEntriesTable.$inferSelect;

import { pgTable, text, serial, timestamp, integer, real, index } from "drizzle-orm/pg-core";

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

export type AlphaMarketEntry = typeof alphaMarketEntriesTable.$inferSelect;

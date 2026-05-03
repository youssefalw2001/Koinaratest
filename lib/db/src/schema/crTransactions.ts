import { pgTable, text, serial, timestamp, integer, numeric, index } from "drizzle-orm/pg-core";

export const crTransactionsTable = pgTable("cr_transactions", {
  id: serial("id").primaryKey(),
  referrerTelegramId: text("referrer_telegram_id").notNull(),
  sourceTelegramId: text("source_telegram_id").notNull(),
  purchaseType: text("purchase_type").notNull(),
  grossUsd: numeric("gross_usd", { precision: 10, scale: 2 }).notNull(),
  crAmount: integer("cr_amount").notNull(),
  level: integer("level").notNull().default(1),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  maturesAt: timestamp("matures_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_cr_tx_referrer").on(table.referrerTelegramId),
  index("idx_cr_tx_source").on(table.sourceTelegramId),
  index("idx_cr_tx_status").on(table.status),
  index("idx_cr_tx_matures_at").on(table.maturesAt),
]);

export type CrTransaction = typeof crTransactionsTable.$inferSelect;

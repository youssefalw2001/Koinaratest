import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";

export const crTransactionsTable = pgTable("cr_transactions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  type: text("type").notNull(),
  crAmount: integer("cr_amount").notNull(),
  sourceType: text("source_type").notNull(),
  sourceTelegramId: text("source_telegram_id"),
  usdEquivalent: real("usd_equivalent"),
  payoutNetwork: text("payout_network"),
  walletAddress: text("wallet_address"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export type CrTransaction = typeof crTransactionsTable.$inferSelect;
export type InsertCrTransaction = typeof crTransactionsTable.$inferInsert;

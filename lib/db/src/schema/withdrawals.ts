import { pgTable, text, serial, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const withdrawalQueueTable = pgTable("withdrawal_queue", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  amountGc: integer("amount_gc").notNull(),
  feePct: real("fee_pct").notNull().default(0.025),
  feeGc: integer("fee_gc").notNull(),
  netGc: integer("net_gc").notNull(),
  usdValue: real("usd_value").notNull(),
  netUsd: real("net_usd").notNull().default(0),
  status: text("status").notNull().default("pending"),
  walletAddress: text("wallet_address").notNull(),
  txHash: text("tx_hash"),
  isVip: integer("is_vip").notNull().default(0),
  tier: text("tier").notNull().default("free"),
  processesAt: timestamp("processes_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_withdrawal_queue_telegram_id").on(table.telegramId),
  index("idx_withdrawal_queue_status").on(table.status),
]);

export const platformDailyStatsTable = pgTable("platform_daily_stats", {
  date: text("date").primaryKey(),
  totalRevenueGc: integer("total_revenue_gc").notNull().default(0),
  totalPaidOutGc: integer("total_paid_out_gc").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertWithdrawalSchema = createInsertSchema(withdrawalQueueTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type Withdrawal = typeof withdrawalQueueTable.$inferSelect;
export type PlatformDailyStats = typeof platformDailyStatsTable.$inferSelect;

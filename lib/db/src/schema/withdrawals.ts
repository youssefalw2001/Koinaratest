import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const withdrawalQueueTable = pgTable("withdrawal_queue", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  amountGc: integer("amount_gc").notNull(),
  feeGc: integer("fee_gc").notNull(),
  netGc: integer("net_gc").notNull(),
  usdValue: real("usd_value").notNull(),
  status: text("status").notNull().default("pending"),
  walletAddress: text("wallet_address").notNull(),
  txHash: text("tx_hash"),
  isVip: integer("is_vip").notNull().default(0),
  processAt: timestamp("process_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertWithdrawalSchema = createInsertSchema(withdrawalQueueTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type Withdrawal = typeof withdrawalQueueTable.$inferSelect;

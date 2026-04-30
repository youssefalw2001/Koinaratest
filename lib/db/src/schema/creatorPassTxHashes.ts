import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const creatorPassTxHashesTable = pgTable("creator_pass_tx_hashes", {
  id: serial("id").primaryKey(),
  txHash: text("tx_hash").notNull().unique(),
  telegramId: text("telegram_id").notNull(),
  paymentMethod: text("payment_method").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CreatorPassTxHash = typeof creatorPassTxHashesTable.$inferSelect;
export type InsertCreatorPassTxHash = typeof creatorPassTxHashesTable.$inferInsert;

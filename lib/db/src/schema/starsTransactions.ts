import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const starsTransactionsTable = pgTable("stars_transactions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  starsAmount: integer("stars_amount").notNull(),
  productType: text("product_type").notNull(),
  productId: text("product_id").notNull(),
  telegramPaymentChargeId: text("telegram_payment_charge_id").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("completed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_stars_transactions_telegram_id").on(table.telegramId, table.createdAt),
  uniqueIndex("idx_stars_transactions_charge_id").on(table.telegramPaymentChargeId),
]);

export type StarsTransaction = typeof starsTransactionsTable.$inferSelect;
export type InsertStarsTransaction = typeof starsTransactionsTable.$inferInsert;

import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const vipTxHashesTable = pgTable("vip_tx_hashes", {
  id: serial("id").primaryKey(),
  txHash: text("tx_hash").notNull().unique(),
  telegramId: text("telegram_id").notNull(),
  plan: text("plan").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

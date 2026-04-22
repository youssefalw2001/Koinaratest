import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const tcPackTxHashesTable = pgTable("tc_pack_tx_hashes", {
  id: serial("id").primaryKey(),
  txHash: text("tx_hash").notNull().unique(),
  telegramId: text("telegram_id").notNull(),
  pack: text("pack").notNull(),
  tcAwarded: integer("tc_awarded").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_tc_pack_tx_telegram_id").on(table.telegramId),
]);

export type TcPackTx = typeof tcPackTxHashesTable.$inferSelect;

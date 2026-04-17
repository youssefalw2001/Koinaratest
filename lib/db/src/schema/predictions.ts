import { pgTable, text, serial, timestamp, integer, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const predictionsTable = pgTable("predictions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  direction: text("direction").notNull(),
  amount: integer("amount").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  status: text("status").notNull().default("pending"),
  payout: integer("payout"),
  duration: integer("duration").notNull().default(60),
  multiplier: real("multiplier").notNull().default(1.7),
  autoResolved: boolean("auto_resolved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const insertPredictionSchema = createInsertSchema(predictionsTable).omit({ id: true, createdAt: true });
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type Prediction = typeof predictionsTable.$inferSelect;

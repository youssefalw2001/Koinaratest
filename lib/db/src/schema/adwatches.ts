import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const adWatchesTable = pgTable("ad_watches", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  tcAwarded: integer("tc_awarded").notNull(),
  watchedAt: timestamp("watched_at", { withTimezone: true }).notNull().defaultNow(),
  dailyCount: integer("daily_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAdWatchSchema = createInsertSchema(adWatchesTable).omit({ id: true, createdAt: true, watchedAt: true });
export type InsertAdWatch = z.infer<typeof insertAdWatchSchema>;
export type AdWatch = typeof adWatchesTable.$inferSelect;

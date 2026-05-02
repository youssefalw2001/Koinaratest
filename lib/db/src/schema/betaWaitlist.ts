import { index, pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const betaWaitlistTable = pgTable("beta_waitlist", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  photoUrl: text("photo_url"),
  source: text("source"),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  telegramIdIdx: index("beta_waitlist_telegram_id_idx").on(table.telegramId),
  createdAtIdx: index("beta_waitlist_created_at_idx").on(table.createdAt),
  sourceIdx: index("beta_waitlist_source_idx").on(table.source),
}));

export type BetaWaitlist = typeof betaWaitlistTable.$inferSelect;
export type InsertBetaWaitlist = typeof betaWaitlistTable.$inferInsert;

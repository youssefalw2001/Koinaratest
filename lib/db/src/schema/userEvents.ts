import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const userEventsTable = pgTable("user_events", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id"),
  eventType: text("event_type").notNull(),
  source: text("source"),
  sessionId: text("session_id"),
  route: text("route"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  telegramIdIdx: index("user_events_telegram_id_idx").on(table.telegramId),
  eventTypeIdx: index("user_events_event_type_idx").on(table.eventType),
  createdAtIdx: index("user_events_created_at_idx").on(table.createdAt),
  sourceIdx: index("user_events_source_idx").on(table.source),
}));

export type UserEvent = typeof userEventsTable.$inferSelect;
export type InsertUserEvent = typeof userEventsTable.$inferInsert;

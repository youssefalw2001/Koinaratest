import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const contentSubmissionsTable = pgTable("content_submissions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  platform: text("platform").notNull(),
  url: text("url").notNull(),
  viewCount: integer("view_count").notNull().default(0),
  status: text("status").notNull().default("pending"),
  gcAwarded: integer("gc_awarded").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertContentSubmissionSchema = createInsertSchema(contentSubmissionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContentSubmission = z.infer<typeof insertContentSubmissionSchema>;
export type ContentSubmission = typeof contentSubmissionsTable.$inferSelect;

import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const contentSubmissionsTable = pgTable("content_submissions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),

  // Platform: tiktok | instagram | youtube | whatsapp
  platform: text("platform").notNull(),

  // Post type: "story" (WhatsApp stories — lower GC) or "post" (real 15s+ content — higher GC)
  postType: text("post_type").notNull().default("post"),

  // URL of the content (must be publicly accessible)
  url: text("url").notNull(),

  // Status: pending → verified → rewarded | deleted | rejected | expired
  //   pending   = just submitted, awaiting URL verification
  //   verified  = URL confirmed live, GC credited, waiting for 6hr deletion check
  //   rewarded  = passed 6hr check, fully complete
  //   deleted   = user deleted the post within 6hrs, GC clawed back
  //   rejected  = URL invalid, spam detected, or duplicate
  //   expired   = story expired before verification (WhatsApp stories)
  status: text("status").notNull().default("pending"),

  // GC awarded on verification (may be clawed back if deleted)
  gcAwarded: integer("gc_awarded").notNull().default(0),

  // Timestamps for the verification pipeline
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  deletionCheckAt: timestamp("deletion_check_at", { withTimezone: true }),
  deletionChecked: boolean("deletion_checked").notNull().default(false),
  deletionCheckPassed: boolean("deletion_check_passed"),

  // Anti-spam: fingerprint hash (telegramId + platform + date) to enforce daily limits
  dailyFingerprint: text("daily_fingerprint"),

  // Legacy field (kept for backwards compat)
  viewCount: integer("view_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_content_telegram_id").on(table.telegramId),
  index("idx_content_status").on(table.status),
  index("idx_content_deletion_check").on(table.deletionCheckAt),
  uniqueIndex("uq_content_url").on(table.url),
  uniqueIndex("uq_content_daily_fingerprint").on(table.dailyFingerprint),
]);

export const insertContentSubmissionSchema = createInsertSchema(contentSubmissionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContentSubmission = z.infer<typeof insertContentSubmissionSchema>;
export type ContentSubmission = typeof contentSubmissionsTable.$inferSelect;

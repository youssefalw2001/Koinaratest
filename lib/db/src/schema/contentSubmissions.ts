import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const contentSubmissionsTable = pgTable("content_submissions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),

  // Platform: tiktok | instagram | youtube | x | whatsapp
  platform: text("platform").notNull(),

  // Post type: story | short | long | post
  postType: text("post_type").notNull().default("post"),

  // URL of the content (must be publicly accessible)
  url: text("url").notNull(),

  // Caption the user included in their post (must contain required promo text)
  caption: text("caption"),

  // Optional admin/user-provided metrics for manual review
  viewCount: integer("view_count").notNull().default(0),
  likeCount: integer("like_count").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  verifiedSignups: integer("verified_signups").notNull().default(0),
  vipReferrals: integer("vip_referrals").notNull().default(0),

  // Status: pending → approved → rewarded | rejected | deleted | expired
  status: text("status").notNull().default("pending"),

  // Rewards granted after admin approval
  xpAwarded: integer("xp_awarded").notNull().default(0),
  creatorXpAwarded: integer("creator_xp_awarded").notNull().default(0),
  valueXpAwarded: integer("value_xp_awarded").notNull().default(0),
  tcAwarded: integer("tc_awarded").notNull().default(0),
  gcAwarded: integer("gc_awarded").notNull().default(0),
  capBoostGcAwarded: integer("cap_boost_gc_awarded").notNull().default(0),

  adminNotes: text("admin_notes"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

  // Timestamps for optional deletion/recheck pipeline
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  deletionCheckAt: timestamp("deletion_check_at", { withTimezone: true }),
  deletionChecked: boolean("deletion_checked").notNull().default(false),
  deletionCheckPassed: boolean("deletion_check_passed"),

  // Anti-spam: fingerprint hash (telegramId + platform + date) to enforce daily limits
  dailyFingerprint: text("daily_fingerprint"),

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

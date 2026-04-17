import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  photoUrl: text("photo_url"),
  tradeCredits: integer("trade_credits").notNull().default(500),
  goldCoins: integer("gold_coins").notNull().default(0),
  totalGcEarned: integer("total_gc_earned").notNull().default(0),
  isVip: boolean("is_vip").notNull().default(false),
  vipExpiresAt: timestamp("vip_expires_at", { withTimezone: true }),
  vipPlan: text("vip_plan"),
  vipTrialExpiresAt: timestamp("vip_trial_expires_at", { withTimezone: true }),
  hadVipTrial: boolean("had_vip_trial").notNull().default(false),
  referralVipRewardPending: boolean("referral_vip_reward_pending").notNull().default(false),
  hasVerified: boolean("has_verified").notNull().default(false),
  walletAddress: text("wallet_address"),
  referredBy: text("referred_by"),
  loginStreak: integer("login_streak").notNull().default(0),
  lastLoginDate: text("last_login_date"),
  registrationDate: text("registration_date"),
  dailyGcEarned: integer("daily_gc_earned").notNull().default(0),
  dailyGcDate: text("daily_gc_date"),
  weeklyWithdrawnGc: integer("weekly_withdrawn_gc").notNull().default(0),
  weeklyWithdrawnResetAt: text("weekly_withdrawn_reset_at"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

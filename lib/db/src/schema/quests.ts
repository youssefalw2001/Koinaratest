import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const questsTable = pgTable("quests", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  reward: integer("reward").notNull(),
  externalUrl: text("external_url").notNull(),
  category: text("category").notNull(),
  isVipOnly: boolean("is_vip_only").notNull().default(false),
  iconName: text("icon_name").notNull().default("star"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questClaimsTable = pgTable("quest_claims", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  questId: integer("quest_id").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertQuestSchema = createInsertSchema(questsTable).omit({ id: true, createdAt: true });
export type InsertQuest = z.infer<typeof insertQuestSchema>;
export type Quest = typeof questsTable.$inferSelect;

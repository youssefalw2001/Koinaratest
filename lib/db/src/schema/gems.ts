import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gemInventoryTable = pgTable("gem_inventory", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  gemType: text("gem_type").notNull(),
  quantity: integer("quantity").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertGemSchema = createInsertSchema(gemInventoryTable).omit({ id: true, createdAt: true });
export type InsertGem = z.infer<typeof insertGemSchema>;
export type Gem = typeof gemInventoryTable.$inferSelect;

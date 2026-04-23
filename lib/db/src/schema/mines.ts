import { pgTable, serial, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";

export const minesRoundsTable = pgTable("mines_rounds", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  gridSize: integer("grid_size").notNull(),           // 3, 4, or 5
  minesCount: integer("mines_count").notNull(),
  bet: integer("bet").notNull(),                      // TC wagered
  serverSeed: text("server_seed").notNull(),          // revealed on settle
  serverSeedHash: text("server_seed_hash").notNull(), // revealed at start
  clientSeed: text("client_seed").notNull(),
  revealed: text("revealed").notNull().default("[]"), // JSON int[] of revealed tile indices
  status: text("status").notNull().default("active"), // active | bust | won
  multiplier: real("multiplier").notNull().default(1),
  payout: integer("payout"),                          // TC returned (null while active)
  // Power-up state: JSON object tracking active gems for this round
  // e.g. {"revenge_shield":true,"gem_magnet_left":3,"second_chance":true}
  activeGems: text("active_gems").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("idx_mines_rounds_telegram_id").on(table.telegramId),
  index("idx_mines_rounds_status").on(table.status),
]);

export type MinesRound = typeof minesRoundsTable.$inferSelect;

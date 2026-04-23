import { pgTable, serial, text, integer, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const minesRoundsTable = pgTable("mines_rounds", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  gridSize: integer("grid_size").notNull(),           // 3, 4, or 5
  minesCount: integer("mines_count").notNull(),
  bet: integer("bet").notNull(),                      // TC or GC wagered (depends on mode)
  serverSeed: text("server_seed").notNull(),          // revealed on settle
  serverSeedHash: text("server_seed_hash").notNull(), // revealed at start
  clientSeed: text("client_seed").notNull(),
  revealed: text("revealed").notNull().default("[]"), // JSON int[] of revealed tile indices
  status: text("status").notNull().default("active"), // active | bust | won
  multiplier: real("multiplier").notNull().default(1),
  payout: integer("payout"),                          // TC or GC returned (null while active)
  // Power-up state: JSON object tracking active gems for this round
  activeGems: text("active_gems").notNull().default("{}"),
  // GC Mines Mode fields
  mode: text("mode").notNull().default("tc"),         // "tc" (classic) | "gc" (GC Mines)
  tier: text("tier"),                                 // null for tc mode; "bronze" | "silver" | "gold"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("idx_mines_rounds_telegram_id").on(table.telegramId),
  index("idx_mines_rounds_status").on(table.status),
]);

export type MinesRound = typeof minesRoundsTable.$inferSelect;

// Round passes — purchased with TON entry fees for GC Mines tiers
export const minesRoundPassesTable = pgTable("mines_round_passes", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull(),
  tier: text("tier").notNull(),                       // "bronze" | "silver" | "gold"
  remaining: integer("remaining").notNull().default(0), // rounds left in this pack
  txHash: text("tx_hash"),                            // TON transaction hash for dedup
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_mines_passes_telegram_id").on(table.telegramId),
  index("idx_mines_passes_tier").on(table.tier),
  uniqueIndex("uq_mines_passes_tx_hash").on(table.txHash),
]);

export type MinesRoundPass = typeof minesRoundPassesTable.$inferSelect;

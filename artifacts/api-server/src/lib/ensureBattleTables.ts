import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

let hasRun = false;

export async function ensureBattleTables(): Promise<void> {
  if (hasRun) return;
  hasRun = true;

  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_battle_gc_earned integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_battle_gc_date text;

      CREATE TABLE IF NOT EXISTS battles (
        id serial PRIMARY KEY,
        battle_code text NOT NULL UNIQUE,
        player1_telegram_id text NOT NULL,
        player2_telegram_id text,
        stake_tc integer NOT NULL,
        player1_prediction text,
        player2_prediction text,
        status text NOT NULL DEFAULT 'waiting',
        battle_type text NOT NULL DEFAULT 'quick',
        symbol text NOT NULL DEFAULT 'BTCUSDT',
        start_price real,
        end_price real,
        winner_telegram_id text,
        gc_payout integer NOT NULL DEFAULT 0,
        refunded_tc integer NOT NULL DEFAULT 0,
        house_tc_kept integer NOT NULL DEFAULT 0,
        is_draw boolean NOT NULL DEFAULT false,
        started_at timestamptz,
        resolved_at timestamptz,
        expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_battles_code ON battles(battle_code);
      CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
      CREATE INDEX IF NOT EXISTS idx_battles_player1 ON battles(player1_telegram_id);
      CREATE INDEX IF NOT EXISTS idx_battles_player2 ON battles(player2_telegram_id);
      CREATE INDEX IF NOT EXISTS idx_battles_created_at ON battles(created_at);
    `);
    logger.info("Battle tables ensured.");
  } catch (err) {
    logger.error({ err }, "Failed to ensure Battle tables.");
    throw err;
  }
}

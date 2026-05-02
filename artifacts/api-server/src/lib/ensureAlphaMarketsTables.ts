import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

let hasRun = false;

export async function ensureAlphaMarketsTables(): Promise<void> {
  if (hasRun) return;
  hasRun = true;

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS alpha_markets (
        id serial PRIMARY KEY,
        market_id text NOT NULL UNIQUE,
        symbol text NOT NULL DEFAULT 'BTCUSDT',
        duration_sec integer NOT NULL,
        question text NOT NULL,
        open_price real NOT NULL,
        close_price real,
        result_side text,
        status text NOT NULL DEFAULT 'open',
        yes_pool_tc integer NOT NULL DEFAULT 0,
        no_pool_tc integer NOT NULL DEFAULT 0,
        entry_count integer NOT NULL DEFAULT 0,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        settled_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS alpha_market_entries (
        id serial PRIMARY KEY,
        telegram_id text NOT NULL,
        market_id text NOT NULL,
        symbol text NOT NULL DEFAULT 'BTCUSDT',
        side text NOT NULL,
        amount_tc integer NOT NULL,
        open_price real NOT NULL,
        close_price real,
        status text NOT NULL DEFAULT 'open',
        payout_gc integer NOT NULL DEFAULT 0,
        alpha_points integer NOT NULL DEFAULT 0,
        power_up text,
        duration_sec integer NOT NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        settled_at timestamptz
      );

      ALTER TABLE alpha_market_entries ADD COLUMN IF NOT EXISTS alpha_points integer NOT NULL DEFAULT 0;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_markets_market_id ON alpha_markets(market_id);
      CREATE INDEX IF NOT EXISTS idx_alpha_markets_status ON alpha_markets(status);
      CREATE INDEX IF NOT EXISTS idx_alpha_markets_end_at ON alpha_markets(end_at);
      CREATE INDEX IF NOT EXISTS idx_alpha_market_entries_telegram_id ON alpha_market_entries(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_alpha_market_entries_market_id ON alpha_market_entries(market_id);
      CREATE INDEX IF NOT EXISTS idx_alpha_market_entries_status ON alpha_market_entries(status);
    `);
    logger.info("Alpha Markets tables ensured.");
  } catch (err) {
    logger.error({ err }, "Failed to ensure Alpha Markets tables.");
    throw err;
  }
}

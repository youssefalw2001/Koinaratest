import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Small, idempotent startup migrations for production safety.
 *
 * Railway mobile makes manual SQL difficult, so this keeps the API deploy from
 * failing when a new nullable/defaulted column is required by freshly deployed
 * code. Every statement here must be safe to run repeatedly.
 */
export async function runStartupMigrations(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS daily_trade_cap_boost_gc integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS daily_trade_cap_boost_date text,
    ADD COLUMN IF NOT EXISTS creator_credits integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS creator_pass_paid boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS creator_pass_paid_at timestamptz,
    ADD COLUMN IF NOT EXISTS total_cr_earned integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_cr_withdrawn integer NOT NULL DEFAULT 0
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cr_transactions (
      id serial PRIMARY KEY,
      telegram_id text NOT NULL,
      type text NOT NULL,
      cr_amount integer NOT NULL,
      source_type text NOT NULL,
      source_telegram_id text,
      usd_equivalent real,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      approved_at timestamptz,
      paid_at timestamptz
    )
  `);

  logger.info("Startup migrations completed");
}

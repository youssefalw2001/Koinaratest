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
    ADD COLUMN IF NOT EXISTS daily_trade_cap_boost_date text
  `);

  logger.info("Startup migrations completed");
}

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

let hasRun = false;

export async function ensureCreatorMissionColumns(): Promise<void> {
  if (hasRun) return;
  hasRun = true;

  try {
    await db.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_xp integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_xp integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS value_xp integer NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_level integer NOT NULL DEFAULT 1;

      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS like_count integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS verified_signups integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS vip_referrals integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS xp_awarded integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS creator_xp_awarded integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS value_xp_awarded integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS tc_awarded integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS cap_boost_gc_awarded integer NOT NULL DEFAULT 0;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS admin_notes text;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS reviewed_by text;
      ALTER TABLE content_submissions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
    `);
    logger.info("Creator Missions columns ensured.");
  } catch (err) {
    logger.error({ err }, "Failed to ensure Creator Missions columns.");
    throw err;
  }
}

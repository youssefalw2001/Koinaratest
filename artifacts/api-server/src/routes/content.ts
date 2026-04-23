import { Router, type IRouter } from "express";
import { eq, and, sql, lte } from "drizzle-orm";
import { db, contentSubmissionsTable, usersTable } from "@workspace/db";
import { serializeRows, serializeRow } from "../lib/serialize";
import { z } from "zod/v4";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { logger } from "../lib/logger";
import crypto from "crypto";

const router: IRouter = Router();

// ─── Reward Configuration ──────────────────────────────────────────────────
const REWARDS: Record<string, Record<string, number>> = {
  story: {
    whatsapp: 800,
  },
  post: {
    tiktok: 2000,
    instagram: 1500,
    youtube: 2500,
  },
};

const DAILY_LIMITS: Record<string, number> = {
  whatsapp: 2,
  tiktok: 1,
  instagram: 1,
  youtube: 1,
};

const DAILY_CONTENT_GC_CAP = 5000;
const DELETION_CHECK_HOURS = 6;

// ─── URL Validation Patterns ────────────────────────────────────────────────
const URL_PATTERNS: Record<string, RegExp> = {
  tiktok: /^https?:\/\/(www\.|vm\.)?tiktok\.com\//i,
  instagram: /^https?:\/\/(www\.)?instagram\.com\/(reel|p|stories)\//i,
  youtube: /^https?:\/\/(www\.|m\.)?(youtube\.com\/(shorts|watch)|youtu\.be\/)/i,
  whatsapp: /^https?:\/\/(www\.)?wa\.me\/|^https?:\/\/chat\.whatsapp\.com\/|^screenshot:/i,
};

async function isUrlLive(url: string): Promise<boolean> {
  if (url.startsWith("screenshot:")) return true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KoinaraBot/1.0)" },
    });
    clearTimeout(timeout);
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  }
}

function dailyFingerprint(telegramId: string, platform: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return crypto.createHash("sha256").update(`${telegramId}:${platform}:${today}`).digest("hex");
}

async function todayContentGc(telegramId: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ gcAwarded: contentSubmissionsTable.gcAwarded })
    .from(contentSubmissionsTable)
    .where(
      and(
        eq(contentSubmissionsTable.telegramId, telegramId),
        sql`${contentSubmissionsTable.createdAt} >= ${todayStart}`,
        sql`${contentSubmissionsTable.status} IN ('verified', 'rewarded')`,
      ),
    );
  return rows.reduce((sum, r) => sum + (r.gcAwarded ?? 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /content/submit — Submit content for GC reward (NO VIP REQUIRED)
// ═══════════════════════════════════════════════════════════════════════════
const SubmitContentBody = z.object({
  telegramId: z.string(),
  platform: z.enum(["tiktok", "instagram", "youtube", "whatsapp"]),
  postType: z.enum(["story", "post"]),
  url: z.string().min(5),
});

router.post("/content/submit", async (req, res): Promise<void> => {
  const parsed = SubmitContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!authedId) return;

  const { platform, postType, url } = parsed.data;

  // Validate platform + postType combination
  if (postType === "story" && platform !== "whatsapp") {
    res.status(400).json({ error: "Story mode is only available for WhatsApp." });
    return;
  }
  if (postType === "post" && platform === "whatsapp") {
    res.status(400).json({ error: "WhatsApp only supports story mode." });
    return;
  }

  // Validate URL pattern
  const pattern = URL_PATTERNS[platform];
  if (pattern && !pattern.test(url)) {
    res.status(400).json({ error: `Invalid ${platform} URL. Please submit a valid link to your content.` });
    return;
  }

  // Check user exists
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  // Anti-spam: daily limit per platform
  const fingerprint = dailyFingerprint(authedId, platform);
  const dailyLimit = DAILY_LIMITS[platform] ?? 1;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todaySubmissions = await db
    .select({ id: contentSubmissionsTable.id })
    .from(contentSubmissionsTable)
    .where(
      and(
        eq(contentSubmissionsTable.telegramId, authedId),
        eq(contentSubmissionsTable.platform, platform),
        sql`${contentSubmissionsTable.createdAt} >= ${todayStart}`,
        sql`${contentSubmissionsTable.status} NOT IN ('rejected')`,
      ),
    );
  if (todaySubmissions.length >= dailyLimit) {
    res.status(429).json({
      error: `You have reached your daily limit for ${platform} (${dailyLimit} per day). Come back tomorrow!`,
    });
    return;
  }

  // Daily GC cap check
  const gcEarnedToday = await todayContentGc(authedId);
  if (gcEarnedToday >= DAILY_CONTENT_GC_CAP) {
    res.status(429).json({
      error: `You have reached the daily content reward cap (${DAILY_CONTENT_GC_CAP} GC). Come back tomorrow!`,
    });
    return;
  }

  // Verify URL is live
  const live = await isUrlLive(url);
  if (!live) {
    res.status(400).json({
      error: "Could not verify your content URL. Make sure the post is public and the link is correct.",
    });
    return;
  }

  // Calculate reward
  const rewardMap = REWARDS[postType];
  const gcReward = rewardMap?.[platform] ?? 0;
  if (gcReward === 0) {
    res.status(400).json({ error: "Invalid platform/post type combination." });
    return;
  }

  const cappedReward = Math.min(gcReward, DAILY_CONTENT_GC_CAP - gcEarnedToday);

  const now = new Date();
  const deletionCheckAt = new Date(now.getTime() + DELETION_CHECK_HOURS * 60 * 60 * 1000);

  try {
    const [submission] = await db
      .insert(contentSubmissionsTable)
      .values({
        telegramId: authedId,
        platform,
        postType,
        url,
        status: "verified",
        gcAwarded: cappedReward,
        verifiedAt: now,
        deletionCheckAt,
        deletionChecked: false,
        dailyFingerprint: fingerprint,
      })
      .returning();

    // Credit GC immediately
    if (cappedReward > 0) {
      await db
        .update(usersTable)
        .set({
          goldCoins: sql`${usersTable.goldCoins} + ${cappedReward}`,
          totalGcEarned: sql`${usersTable.totalGcEarned} + ${cappedReward}`,
        })
        .where(eq(usersTable.telegramId, authedId));
    }

    logger.info(
      { telegramId: authedId, platform, postType, gcReward: cappedReward, url },
      "Content submitted and verified",
    );

    res.status(201).json({
      id: submission.id,
      platform,
      postType,
      gcAwarded: cappedReward,
      status: "verified",
      deletionCheckAt: deletionCheckAt.toISOString(),
      message: `+${cappedReward} GC! Keep your post live for 6 hours to keep the reward.`,
      dailyGcFromContent: gcEarnedToday + cappedReward,
      dailyGcCap: DAILY_CONTENT_GC_CAP,
    });
  } catch (err: any) {
    if (err?.code === "23505" && err?.constraint?.includes("uq_content_url")) {
      res.status(409).json({ error: "This content URL has already been submitted." });
      return;
    }
    if (err?.code === "23505" && err?.constraint?.includes("uq_content_daily_fingerprint")) {
      res.status(429).json({ error: "You have already submitted content for this platform today." });
      return;
    }
    logger.error({ err, telegramId: authedId }, "Content submission failed");
    res.status(500).json({ error: "Failed to submit content." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /content/:telegramId — List user's content submissions
// ═══════════════════════════════════════════════════════════════════════════
router.get("/content/:telegramId", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required." });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [requestUser] = await db
    .select({ telegramId: usersTable.telegramId })
    .from(usersTable)
    .where(eq(usersTable.telegramId, authedId))
    .limit(1);
  if (!requestUser) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const submissions = await db
    .select()
    .from(contentSubmissionsTable)
    .where(eq(contentSubmissionsTable.telegramId, authedId))
    .orderBy(contentSubmissionsTable.createdAt);

  const gcEarnedToday = await todayContentGc(authedId);

  res.json({
    submissions: serializeRows(submissions as Record<string, unknown>[]),
    dailyGcFromContent: gcEarnedToday,
    dailyGcCap: DAILY_CONTENT_GC_CAP,
    rewards: {
      story: { whatsapp: REWARDS.story.whatsapp },
      post: { tiktok: REWARDS.post.tiktok, instagram: REWARDS.post.instagram, youtube: REWARDS.post.youtube },
    },
    dailyLimits: DAILY_LIMITS,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /content/status/:submissionId — Check a specific submission's status
// ═══════════════════════════════════════════════════════════════════════════
router.get("/content/status/:submissionId", async (req, res): Promise<void> => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (isNaN(submissionId)) {
    res.status(400).json({ error: "Invalid submission ID." });
    return;
  }

  const [sub] = await db
    .select()
    .from(contentSubmissionsTable)
    .where(eq(contentSubmissionsTable.id, submissionId))
    .limit(1);

  if (!sub) {
    res.status(404).json({ error: "Submission not found." });
    return;
  }

  res.json(serializeRow(sub as Record<string, unknown>));
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /content/deletion-check — Cron endpoint: verify posts still live
// after 6 hours. If deleted, claw back GC. Run every 30 minutes.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/content/deletion-check", async (_req, res): Promise<void> => {
  const now = new Date();

  const dueSubmissions = await db
    .select()
    .from(contentSubmissionsTable)
    .where(
      and(
        eq(contentSubmissionsTable.status, "verified"),
        eq(contentSubmissionsTable.deletionChecked, false),
        lte(contentSubmissionsTable.deletionCheckAt, now),
      ),
    )
    .limit(100);

  let passed = 0;
  let clawedBack = 0;

  for (const sub of dueSubmissions) {
    const stillLive = await isUrlLive(sub.url);

    if (stillLive) {
      await db
        .update(contentSubmissionsTable)
        .set({
          status: "rewarded",
          deletionChecked: true,
          deletionCheckPassed: true,
        })
        .where(eq(contentSubmissionsTable.id, sub.id));
      passed++;
    } else {
      await db
        .update(contentSubmissionsTable)
        .set({
          status: "deleted",
          deletionChecked: true,
          deletionCheckPassed: false,
        })
        .where(eq(contentSubmissionsTable.id, sub.id));

      if (sub.gcAwarded > 0) {
        await db
          .update(usersTable)
          .set({
            goldCoins: sql`GREATEST(${usersTable.goldCoins} - ${sub.gcAwarded}, 0)`,
            totalGcEarned: sql`GREATEST(${usersTable.totalGcEarned} - ${sub.gcAwarded}, 0)`,
          })
          .where(eq(usersTable.telegramId, sub.telegramId));
      }

      clawedBack++;
      logger.info(
        { telegramId: sub.telegramId, submissionId: sub.id, gcClawedBack: sub.gcAwarded },
        "Content deleted within 6hrs — GC clawed back",
      );
    }
  }

  res.json({ checked: dueSubmissions.length, passed, clawedBack });
});

export default router;

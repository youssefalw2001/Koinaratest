import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, lte } from "drizzle-orm";
import { db, contentSubmissionsTable, usersTable } from "@workspace/db";
import { serializeRows, serializeRow } from "../lib/serialize";
import { z } from "zod/v4";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { isVipActive } from "../lib/vip";
import { logger } from "../lib/logger";
import crypto from "crypto";

function requireAdmin(req: Request, res: Response): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    res.status(503).json({ error: "Admin endpoints are not configured on this server." });
    return false;
  }
  const authHeader = req.headers.authorization ?? "";
  if (authHeader !== `Bearer ${adminSecret}`) {
    res.status(401).json({ error: "Unauthorized." });
    return false;
  }
  return true;
}

const router: IRouter = Router();

// ─── Reward Configuration ──────────────────────────────────────────────────
const REWARDS: Record<string, Record<string, number>> = {
  story: {
    whatsapp: 640,
  },
  post: {
    tiktok: 1_600,
    instagram: 1_200,
    youtube: 2_000,
  },
};

const DAILY_LIMITS: Record<string, number> = {
  whatsapp: 2,
  tiktok: 1,
  instagram: 1,
  youtube: 1,
};

const DAILY_CONTENT_GC_CAP_FREE = 3_000;
const DAILY_CONTENT_GC_CAP_VIP  = 5_000;
const DELETION_CHECK_HOURS = 24;

// Required promotional keywords — post caption must include at least one phrase
const REQUIRED_CAPTION_KEYWORDS = [
  "koinara",
  "koinaraapp",
];

function validateCaption(caption: string): boolean {
  const lower = caption.toLowerCase();
  return REQUIRED_CAPTION_KEYWORDS.some((kw) => lower.includes(kw));
}

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

function dailyFingerprint(telegramId: string, platform: string, index: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return crypto.createHash("sha256").update(`${telegramId}:${platform}:${today}:${index}`).digest("hex");
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
  caption: z.string().min(10).max(1000),
});

router.post("/content/submit", async (req, res): Promise<void> => {
  const parsed = SubmitContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  const authedId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!authedId) return;

  const { platform, postType, url, caption } = parsed.data;

  // Validate caption contains required promotional keywords
  if (!validateCaption(caption)) {
    res.status(400).json({
      error: `Your caption must mention Koinara (e.g. "I earn $3–7/week on Koinara!"). Copy the required text and try again.`,
    });
    return;
  }

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

  // Fingerprint includes the slot index so each allowed submission gets a unique key.
  // This lets WhatsApp (limit=2) get two distinct constraint slots instead of colliding.
  const fingerprint = dailyFingerprint(authedId, platform, todaySubmissions.length);

  // Daily GC cap check (VIP gets higher cap)
  const dailyCap = isVipActive(user) ? DAILY_CONTENT_GC_CAP_VIP : DAILY_CONTENT_GC_CAP_FREE;
  const gcEarnedToday = await todayContentGc(authedId);
  if (gcEarnedToday >= dailyCap) {
    res.status(429).json({
      error: `You have reached the daily content reward cap (${dailyCap} GC). Come back tomorrow!`,
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

  const cappedReward = Math.min(gcReward, dailyCap - gcEarnedToday);

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
        caption,
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
      { telegramId: authedId, platform, postType, gcReward: cappedReward, url, caption },
      "Content submitted and verified",
    );

    res.status(201).json({
      id: submission.id,
      platform,
      postType,
      gcAwarded: cappedReward,
      status: "verified",
      deletionCheckAt: deletionCheckAt.toISOString(),
      message: `+${cappedReward} GC! Keep your post live for 24 hours to keep the reward.`,
      dailyGcFromContent: gcEarnedToday + cappedReward,
      dailyGcCap: dailyCap,
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
    .select()
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
  const dailyCap = isVipActive(requestUser) ? DAILY_CONTENT_GC_CAP_VIP : DAILY_CONTENT_GC_CAP_FREE;

  res.json({
    submissions: serializeRows(submissions as Record<string, unknown>[]),
    dailyGcFromContent: gcEarnedToday,
    dailyGcCap: dailyCap,
    rewards: {
      story: { whatsapp: REWARDS.story.whatsapp },
      post: { tiktok: REWARDS.post.tiktok, instagram: REWARDS.post.instagram, youtube: REWARDS.post.youtube },
    },
    dailyLimits: DAILY_LIMITS,
    requiredCaptionKeywords: REQUIRED_CAPTION_KEYWORDS,
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
// Requires admin Authorization header to prevent external abuse.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/content/deletion-check", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
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
        "Content deleted within 24hrs — GC clawed back",
      );
    }
  }

  res.json({ checked: dueSubmissions.length, passed, clawedBack });
});

export default router;

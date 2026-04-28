import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, lte, desc } from "drizzle-orm";
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

const DAILY_LIMITS: Record<string, number> = {
  whatsapp: 2,
  tiktok: 3,
  instagram: 3,
  youtube: 3,
  x: 3,
};

const REQUIRED_CAPTION_KEYWORDS = ["koinara", "koinaraapp", "koin trades", "koinara trading"];
const VIP_REFERRAL_XP = 10_000;
const VIP_REFERRAL_TC = 25_000;
const YOUTUBE_LONG_BONUS_MULT = 1.75;
const YOUTUBE_SHORT_BONUS_MULT = 1.25;

const URL_PATTERNS: Record<string, RegExp> = {
  tiktok: /^https?:\/\/(www\.|vm\.)?tiktok\.com\//i,
  instagram: /^https?:\/\/(www\.)?instagram\.com\/(reel|p|stories)\//i,
  youtube: /^https?:\/\/(www\.|m\.)?(youtube\.com\/(shorts|watch)|youtu\.be\/)/i,
  x: /^https?:\/\/(www\.)?(x|twitter)\.com\//i,
  whatsapp: /^https?:\/\/(www\.)?wa\.me\/|^https?:\/\/chat\.whatsapp\.com\/|^screenshot:/i,
};

function validateCaption(caption: string): boolean {
  const lower = caption.toLowerCase();
  return REQUIRED_CAPTION_KEYWORDS.some((kw) => lower.includes(kw));
}

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

function rankLevelForXp(rankXp: number): number {
  if (rankXp >= 40_000) return 5;
  if (rankXp >= 15_000) return 4;
  if (rankXp >= 5_000) return 3;
  if (rankXp >= 1_500) return 2;
  return 1;
}

function calculateCreatorReward(input: {
  platform: string;
  postType: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  verifiedSignups: number;
  vipReferrals: number;
}): { xp: number; creatorXp: number; valueXp: number; tc: number; gc: number; capBoostGc: number } {
  const views = Math.max(0, input.viewCount);
  const likes = Math.max(0, input.likeCount);
  const comments = Math.max(0, input.commentCount);
  const signups = Math.max(0, input.verifiedSignups);
  const vipRefs = Math.max(0, input.vipReferrals);

  let platformMult = 1;
  if (input.platform === "youtube" && input.postType === "long") platformMult = YOUTUBE_LONG_BONUS_MULT;
  if (input.platform === "youtube" && input.postType === "short") platformMult = YOUTUBE_SHORT_BONUS_MULT;

  const contentScore = Math.floor((views + likes * 10 + comments * 25) * platformMult);
  const signupScore = signups * 500;
  const vipScore = vipRefs * 5_000;

  const xp = Math.min(60_000, 500 + Math.floor((contentScore + signupScore + vipScore) / 8));
  const creatorXp = xp;
  const valueXp = vipRefs > 0 ? vipRefs * VIP_REFERRAL_XP : signups * 150;

  const tc = Math.min(150_000, 1_000 + Math.floor((contentScore + signupScore) / 2) + vipRefs * VIP_REFERRAL_TC);

  let gc = 0;
  if (input.platform === "youtube") {
    if (views >= 1_000) gc += input.postType === "long" ? 1_000 : 500;
    if (views >= 10_000) gc += input.postType === "long" ? 4_000 : 2_000;
    if (views >= 50_000) gc += input.postType === "long" ? 12_000 : 6_000;
  }
  gc += vipRefs * 2_500;
  gc = Math.min(gc, vipRefs > 0 ? 25_000 : 8_000);

  const capBoostGc = vipRefs > 0 ? Math.min(50_000, vipRefs * 5_000 + signups * 500) : 0;
  return { xp, creatorXp, valueXp, tc, gc, capBoostGc };
}

const SubmitContentBody = z.object({
  telegramId: z.string(),
  platform: z.enum(["tiktok", "instagram", "youtube", "whatsapp", "x"]),
  postType: z.enum(["story", "post", "short", "long"]).default("post"),
  url: z.string().min(5),
  caption: z.string().min(1).max(1000).optional(),
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
  const caption = parsed.data.caption ?? "Koinara creator mission";

  if (!validateCaption(caption)) {
    res.status(400).json({ error: "Caption must mention Koinara or include your Koinara creator/referral code." });
    return;
  }

  const pattern = URL_PATTERNS[platform];
  if (pattern && !pattern.test(url)) {
    res.status(400).json({ error: `Invalid ${platform} URL. Please submit a valid public link.` });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const dailyLimit = DAILY_LIMITS[platform] ?? 1;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todaySubmissions = await db
    .select({ id: contentSubmissionsTable.id })
    .from(contentSubmissionsTable)
    .where(and(eq(contentSubmissionsTable.telegramId, authedId), eq(contentSubmissionsTable.platform, platform), sql`${contentSubmissionsTable.createdAt} >= ${todayStart}`, sql`${contentSubmissionsTable.status} NOT IN ('rejected')`));

  if (todaySubmissions.length >= dailyLimit) {
    res.status(429).json({ error: `Daily ${platform} creator submission limit reached (${dailyLimit}/day).` });
    return;
  }

  const live = await isUrlLive(url);
  if (!live) {
    res.status(400).json({ error: "Could not verify the URL is public. Make sure the post is live." });
    return;
  }

  const fingerprint = dailyFingerprint(authedId, platform, todaySubmissions.length);

  try {
    const [submission] = await db.insert(contentSubmissionsTable).values({
      telegramId: authedId,
      platform,
      postType,
      url,
      caption,
      status: "pending",
      dailyFingerprint: fingerprint,
      gcAwarded: 0,
      xpAwarded: 50,
      creatorXpAwarded: 50,
    }).returning();

    await db.update(usersTable).set({
      rankXp: sql`${usersTable.rankXp} + 50`,
      creatorXp: sql`${usersTable.creatorXp} + 50`,
      rankLevel: sql`GREATEST(${usersTable.rankLevel}, ${rankLevelForXp((user.rankXp ?? 0) + 50)})`,
    }).where(eq(usersTable.telegramId, authedId));

    res.status(201).json({
      id: submission.id,
      platform,
      postType,
      status: "pending",
      xpAwarded: 50,
      message: "+50 XP submitted. Admin review will unlock bigger XP, TC, and possible GC.",
    });
  } catch (err: any) {
    if (err?.code === "23505" && err?.constraint?.includes("uq_content_url")) {
      res.status(409).json({ error: "This content URL has already been submitted." });
      return;
    }
    logger.error({ err, telegramId: authedId }, "Creator content submission failed");
    res.status(500).json({ error: "Failed to submit creator content." });
  }
});

router.get("/content/:telegramId", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required." });
    return;
  }
  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const submissions = await db.select().from(contentSubmissionsTable).where(eq(contentSubmissionsTable.telegramId, authedId)).orderBy(desc(contentSubmissionsTable.createdAt)).limit(50);
  res.json({
    submissions: serializeRows(submissions as Record<string, unknown>[]),
    rewards: {
      submit: { xp: 50 },
      youtubeShort: { note: "Higher tiers unlock after admin verifies views/signups." },
      youtubeLong: { note: "Long-form receives the strongest view multiplier." },
      vipReferral: { xp: VIP_REFERRAL_XP, tc: VIP_REFERRAL_TC, note: "Unlimited income via VIP referral commission." },
    },
    dailyLimits: DAILY_LIMITS,
    requiredCaptionKeywords: REQUIRED_CAPTION_KEYWORDS,
  });
});

router.get("/content/status/:submissionId", async (req, res): Promise<void> => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (isNaN(submissionId)) {
    res.status(400).json({ error: "Invalid submission ID." });
    return;
  }
  const [sub] = await db.select().from(contentSubmissionsTable).where(eq(contentSubmissionsTable.id, submissionId)).limit(1);
  if (!sub) {
    res.status(404).json({ error: "Submission not found." });
    return;
  }
  res.json(serializeRow(sub as Record<string, unknown>));
});

router.get("/admin/content/submissions", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const rows = await db.select().from(contentSubmissionsTable).where(eq(contentSubmissionsTable.status, status)).orderBy(desc(contentSubmissionsTable.createdAt)).limit(100);
  res.json({ submissions: serializeRows(rows as Record<string, unknown>[]) });
});

const ApproveContentBody = z.object({
  adminId: z.string().default("admin"),
  viewCount: z.number().int().min(0).default(0),
  likeCount: z.number().int().min(0).default(0),
  commentCount: z.number().int().min(0).default(0),
  verifiedSignups: z.number().int().min(0).default(0),
  vipReferrals: z.number().int().min(0).default(0),
  xp: z.number().int().min(0).optional(),
  tc: z.number().int().min(0).optional(),
  gc: z.number().int().min(0).optional(),
  capBoostGc: z.number().int().min(0).optional(),
  adminNotes: z.string().max(1000).optional(),
});

router.post("/admin/content/submissions/:id/approve", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid submission ID." });
    return;
  }
  const parsed = ApproveContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [submission] = await tx.select().from(contentSubmissionsTable).where(eq(contentSubmissionsTable.id, id)).for("update").limit(1);
      if (!submission) throw new Error("NOT_FOUND");
      if (submission.status !== "pending") throw new Error("NOT_PENDING");

      const reward = calculateCreatorReward({
        platform: submission.platform,
        postType: submission.postType,
        viewCount: parsed.data.viewCount,
        likeCount: parsed.data.likeCount,
        commentCount: parsed.data.commentCount,
        verifiedSignups: parsed.data.verifiedSignups,
        vipReferrals: parsed.data.vipReferrals,
      });
      const xp = parsed.data.xp ?? reward.xp;
      const creatorXp = xp;
      const valueXp = parsed.data.vipReferrals > 0 ? parsed.data.vipReferrals * VIP_REFERRAL_XP : reward.valueXp;
      const tc = parsed.data.tc ?? reward.tc;
      const gc = parsed.data.gc ?? reward.gc;
      const capBoostGc = parsed.data.capBoostGc ?? reward.capBoostGc;

      const [user] = await tx.select().from(usersTable).where(eq(usersTable.telegramId, submission.telegramId)).for("update").limit(1);
      if (!user) throw new Error("USER_NOT_FOUND");
      const newRankXp = (user.rankXp ?? 0) + xp;

      const [updated] = await tx.update(contentSubmissionsTable).set({
        status: "approved",
        viewCount: parsed.data.viewCount,
        likeCount: parsed.data.likeCount,
        commentCount: parsed.data.commentCount,
        verifiedSignups: parsed.data.verifiedSignups,
        vipReferrals: parsed.data.vipReferrals,
        xpAwarded: xp,
        creatorXpAwarded: creatorXp,
        valueXpAwarded: valueXp,
        tcAwarded: tc,
        gcAwarded: gc,
        capBoostGcAwarded: capBoostGc,
        adminNotes: parsed.data.adminNotes ?? null,
        reviewedBy: parsed.data.adminId,
        reviewedAt: new Date(),
        verifiedAt: new Date(),
      }).where(eq(contentSubmissionsTable.id, id)).returning();

      await tx.update(usersTable).set({
        rankXp: sql`${usersTable.rankXp} + ${xp}`,
        creatorXp: sql`${usersTable.creatorXp} + ${creatorXp}`,
        valueXp: sql`${usersTable.valueXp} + ${valueXp}`,
        rankLevel: sql`GREATEST(${usersTable.rankLevel}, ${rankLevelForXp(newRankXp)})`,
        tradeCredits: sql`${usersTable.tradeCredits} + ${tc}`,
        goldCoins: sql`${usersTable.goldCoins} + ${gc}`,
        totalGcEarned: sql`${usersTable.totalGcEarned} + ${gc}`,
      }).where(eq(usersTable.telegramId, submission.telegramId));

      return updated;
    });
    res.json({ submission: serializeRow(result as Record<string, unknown>), message: "Creator reward approved and credited." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNKNOWN";
    if (msg === "NOT_FOUND") { res.status(404).json({ error: "Submission not found." }); return; }
    if (msg === "NOT_PENDING") { res.status(409).json({ error: "Submission is not pending." }); return; }
    if (msg === "USER_NOT_FOUND") { res.status(404).json({ error: "User not found." }); return; }
    logger.error({ err, id }, "Creator content approval failed");
    res.status(500).json({ error: "Failed to approve creator content." });
  }
});

const RejectContentBody = z.object({ adminId: z.string().default("admin"), adminNotes: z.string().max(1000).optional() });
router.post("/admin/content/submissions/:id/reject", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const parsed = RejectContentBody.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const [updated] = await db.update(contentSubmissionsTable).set({
    status: "rejected",
    reviewedBy: parsed.data.adminId,
    reviewedAt: new Date(),
    adminNotes: parsed.data.adminNotes ?? null,
  }).where(eq(contentSubmissionsTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Submission not found." });
    return;
  }
  res.json({ submission: serializeRow(updated as Record<string, unknown>), message: "Submission rejected." });
});

router.post("/content/deletion-check", async (req, res): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const now = new Date();
  const dueSubmissions = await db.select().from(contentSubmissionsTable).where(and(eq(contentSubmissionsTable.status, "approved"), eq(contentSubmissionsTable.deletionChecked, false), lte(contentSubmissionsTable.deletionCheckAt, now))).limit(100);
  res.json({ checked: dueSubmissions.length, passed: 0, clawedBack: 0, note: "Creator Missions v1 uses manual review. Deletion checks can be enabled later." });
});

export default router;

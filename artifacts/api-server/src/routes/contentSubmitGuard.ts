import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, contentSubmissionsTable, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { isVipActive } from "../lib/vip";
import { logger } from "../lib/logger";
import crypto from "crypto";

const router: IRouter = Router();
const DAILY_LIMITS_FREE: Record<string, number> = { whatsapp: 1, tiktok: 1, instagram: 1, youtube: 1, x: 1 };
const DAILY_LIMITS_VIP: Record<string, number> = { whatsapp: 3, tiktok: 3, instagram: 3, youtube: 2, x: 2 };
const REQUIRED_CAPTION_KEYWORDS = ["koinara", "koinaraapp", "koin trades", "koinara trading", "knr-"];
const CREATOR_SUBMIT_XP = 25;
const CREATOR_SUBMIT_XP_VIP = 50;
const CREATOR_RECHECK_HOURS = 24;
const URL_PATTERNS: Record<string, RegExp> = {
  tiktok: /^https?:\/\/(www\.|vm\.)?tiktok\.com\//i,
  instagram: /^https?:\/\/(www\.)?instagram\.com\/(reel|p|stories)\//i,
  youtube: /^https?:\/\/(www\.|m\.)?(youtube\.com\/(shorts|watch)|youtu\.be\/)/i,
  x: /^https?:\/\/(www\.)?(x|twitter)\.com\//i,
  whatsapp: /^https?:\/\/(www\.)?wa\.me\/|^https?:\/\/chat\.whatsapp\.com\/|^screenshot:/i,
};
const Body = z.object({ telegramId: z.string(), platform: z.enum(["tiktok", "instagram", "youtube", "whatsapp", "x"]), postType: z.enum(["story", "post", "short", "long"]).default("post"), url: z.string().min(5), caption: z.string().min(1).max(1000).optional() });
const okCaption = (s: string) => REQUIRED_CAPTION_KEYWORDS.some((kw) => s.toLowerCase().includes(kw));
const dailyFingerprint = (telegramId: string, platform: string) => crypto.createHash("sha256").update(`${telegramId}:${platform}:${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`).digest("hex");
const limitFor = (platform: string, vip: boolean) => (vip ? DAILY_LIMITS_VIP : DAILY_LIMITS_FREE)[platform] ?? 1;
const rankLevelForXp = (xp: number) => xp >= 40000 ? 5 : xp >= 15000 ? 4 : xp >= 5000 ? 3 : xp >= 1500 ? 2 : 1;
async function isUrlLive(url: string): Promise<boolean> {
  if (url.startsWith("screenshot:")) return true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; KoinaraBot/1.0)" } });
    clearTimeout(timeout);
    return resp.status >= 200 && resp.status < 400;
  } catch { return false; }
}
router.post("/content/submit", async (req, res): Promise<void> => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." }); return; }
  const authedId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
  if (!authedId) return;
  const { platform, postType, url } = parsed.data;
  const caption = parsed.data.caption ?? "Koinara creator mission";
  if (!okCaption(caption)) { res.status(400).json({ error: "Caption must mention Koinara or include your Koinara creator/referral code." }); return; }
  const pattern = URL_PATTERNS[platform];
  if (pattern && !pattern.test(url)) { res.status(400).json({ error: `Invalid ${platform} URL. Please submit a valid public link or screenshot proof.` }); return; }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.telegramId, authedId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found." }); return; }
  const vip = isVipActive(user);
  const dailyLimit = limitFor(platform, vip);
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const todaySubmissions = await db.select({ id: contentSubmissionsTable.id }).from(contentSubmissionsTable).where(and(eq(contentSubmissionsTable.telegramId, authedId), eq(contentSubmissionsTable.platform, platform), sql`${contentSubmissionsTable.createdAt} >= ${todayStart}`, sql`${contentSubmissionsTable.status} NOT IN ('rejected')`));
  if (todaySubmissions.length >= dailyLimit) { res.status(429).json({ error: `Daily ${platform} creator submission limit reached (${dailyLimit}/day). VIP users get higher limits.` }); return; }
  if (!(await isUrlLive(url))) { res.status(400).json({ error: "Could not verify the URL is public. Make sure the post is live." }); return; }
  const submitXp = vip ? CREATOR_SUBMIT_XP_VIP : CREATOR_SUBMIT_XP;
  const deletionCheckAt = platform === "whatsapp" ? null : new Date(Date.now() + CREATOR_RECHECK_HOURS * 60 * 60 * 1000);
  try {
    const [submission] = await db.insert(contentSubmissionsTable).values({ telegramId: authedId, platform, postType, url, caption, status: "pending", dailyFingerprint: dailyFingerprint(authedId, platform), deletionCheckAt, gcAwarded: 0, tcAwarded: 0, xpAwarded: submitXp, creatorXpAwarded: submitXp }).returning();
    await db.update(usersTable).set({ rankXp: sql`${usersTable.rankXp} + ${submitXp}`, creatorXp: sql`${usersTable.creatorXp} + ${submitXp}`, rankLevel: sql`GREATEST(${usersTable.rankLevel}, ${rankLevelForXp((user.rankXp ?? 0) + submitXp)})` }).where(eq(usersTable.telegramId, authedId));
    res.status(201).json({ id: submission.id, platform, postType, status: "pending", xpAwarded: submitXp, dailyLimit, message: `+${submitXp} XP submitted. Rewards stay pending until review; big rewards require real signups or VIP referrals.` });
  } catch (err: any) {
    if (err?.code === "23505" && err?.constraint?.includes("uq_content_url")) { res.status(409).json({ error: "This content URL has already been submitted." }); return; }
    if (err?.code === "23505" && err?.constraint?.includes("uq_content_daily_fingerprint")) { res.status(409).json({ error: "Creator submission already recorded. Please refresh and try again." }); return; }
    logger.error({ err, telegramId: authedId }, "Creator content submission failed");
    res.status(500).json({ error: "Failed to submit creator content." });
  }
});
export default router;

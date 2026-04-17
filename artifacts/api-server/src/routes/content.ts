import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, contentSubmissionsTable, usersTable } from "@workspace/db";
import { serializeRows, serializeRow } from "../lib/serialize";
import { z } from "zod/v4";
import { isVipActive } from "../lib/vip";

const router: IRouter = Router();

const SubmitContentBody = z.object({
  telegramId: z.string(),
  platform: z.enum(["tiktok", "instagram", "youtube", "x"]),
  url: z.url(),
});

router.post("/content/submit", async (req, res): Promise<void> => {
  const parsed = SubmitContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { telegramId, platform, url } = parsed.data;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!isVipActive(user)) {
    res.status(403).json({ error: "Content rewards require VIP" });
    return;
  }

  const [submission] = await db
    .insert(contentSubmissionsTable)
    .values({ telegramId, platform, url, status: "pending" })
    .returning();

  res.status(201).json(serializeRow(submission as Record<string, unknown>));
});

router.get("/content/:telegramId", async (req, res): Promise<void> => {
  const { telegramId } = req.params;
  if (!telegramId) {
    res.status(400).json({ error: "telegramId required" });
    return;
  }

  const [requestUser] = await db
    .select({ telegramId: usersTable.telegramId })
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!requestUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const submissions = await db
    .select()
    .from(contentSubmissionsTable)
    .where(eq(contentSubmissionsTable.telegramId, telegramId))
    .orderBy(contentSubmissionsTable.createdAt);

  res.json(serializeRows(submissions as Record<string, unknown>[]));
});

export default router;

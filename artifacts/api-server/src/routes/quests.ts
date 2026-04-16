import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, questsTable, questClaimsTable, usersTable } from "@workspace/db";
import {
  ClaimQuestParams,
  ClaimQuestBody,
  ClaimQuestResponse,
  ListQuestsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/quests", async (_req, res): Promise<void> => {
  const quests = await db
    .select()
    .from(questsTable)
    .where(eq(questsTable.isActive, true));

  res.json(ListQuestsResponse.parse(quests));
});

router.post("/quests/:id/claim", async (req, res): Promise<void> => {
  const params = ClaimQuestParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = ClaimQuestBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { telegramId } = body.data;
  const questId = params.data.id;

  const [quest] = await db
    .select()
    .from(questsTable)
    .where(eq(questsTable.id, questId))
    .limit(1);

  if (!quest) {
    res.status(404).json({ error: "Quest not found" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (quest.isVipOnly && !user.isVip) {
    res.status(400).json({ error: "This quest is VIP-only" });
    return;
  }

  const existingClaim = await db
    .select()
    .from(questClaimsTable)
    .where(
      and(
        eq(questClaimsTable.telegramId, telegramId),
        eq(questClaimsTable.questId, questId)
      )
    )
    .limit(1);

  if (existingClaim.length > 0) {
    res.status(400).json({ error: "Quest already claimed" });
    return;
  }

  const reward = quest.isVipOnly && user.isVip ? Math.floor(quest.reward * 2.5) : quest.reward;

  await db.insert(questClaimsTable).values({ telegramId, questId });

  const [updatedUser] = await db
    .update(usersTable)
    .set({
      points: sql`${usersTable.points} + ${reward}`,
      totalEarned: sql`${usersTable.totalEarned} + ${reward}`,
    })
    .where(eq(usersTable.telegramId, telegramId))
    .returning();

  const response = {
    pointsAwarded: reward,
    newBalance: updatedUser.points,
    message: `You earned ${reward} Alpha Points!`,
  };

  res.json(ClaimQuestResponse.parse(response));
});

export default router;

import { Router, type IRouter } from "express";
import { isVipActive } from "../lib/vip";
import { eq, and, sql } from "drizzle-orm";
import { db, questsTable, questClaimsTable, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
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

  const authedId = resolveAuthenticatedTelegramId(req, res, telegramId);
  if (!authedId) return;

  const [quest] = await db
    .select()
    .from(questsTable)
    .where(eq(questsTable.id, questId))
    .limit(1);

  if (!quest) {
    res.status(404).json({ error: "Quest not found" });
    return;
  }

  let claimResult: { tcAwarded: number; newTcBalance: number } | null = null;
  let claimError: string | null = null;

  try {
    await db.transaction(async (tx) => {
      const [user] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.telegramId, telegramId))
        .limit(1)
        .for("update");

      if (!user) {
        claimError = "User not found";
        return;
      }

      if (quest.isVipOnly && !isVipActive(user)) {
        claimError = "This quest is VIP-only";
        return;
      }

      const existingClaim = await tx
        .select()
        .from(questClaimsTable)
        .where(and(eq(questClaimsTable.telegramId, telegramId), eq(questClaimsTable.questId, questId)))
        .limit(1);

      if (existingClaim.length > 0) {
        claimError = "Quest already claimed";
        return;
      }

      await tx.insert(questClaimsTable).values({ telegramId, questId });

      const [updatedUser] = await tx
        .update(usersTable)
        .set({ tradeCredits: sql`${usersTable.tradeCredits} + ${quest.reward}` })
        .where(eq(usersTable.telegramId, telegramId))
        .returning();

      claimResult = { tcAwarded: quest.reward, newTcBalance: updatedUser.tradeCredits };
    });
  } catch {
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  if (claimError) {
    const status = claimError === "User not found" ? 404 : 400;
    res.status(status).json({ error: claimError });
    return;
  }

  res.json(ClaimQuestResponse.parse({
    tcAwarded: claimResult!.tcAwarded,
    newTcBalance: claimResult!.newTcBalance,
    message: `You earned ${claimResult!.tcAwarded} Trade Credits!`,
  }));
});

export default router;

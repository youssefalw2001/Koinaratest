import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, withdrawalQueueTable, usersTable } from "@workspace/db";

const router: IRouter = Router();

type FeedRow = {
  type: "withdrawal";
  name: string;
  amountUsd: number;
  network: string;
  createdAt: string | Date | null;
};

function safeName(firstName?: string | null, username?: string | null, telegramId?: string | null): string {
  if (firstName && firstName.trim()) return firstName.trim().slice(0, 18);
  if (username && username.trim()) return `@${username.trim().slice(0, 18)}`;
  return `User ${String(telegramId ?? "0000").slice(-4)}`;
}

router.get("/activity/feed", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      telegramId: withdrawalQueueTable.telegramId,
      netUsd: withdrawalQueueTable.netUsd,
      payoutNetwork: withdrawalQueueTable.payoutNetwork,
      status: withdrawalQueueTable.status,
      createdAt: withdrawalQueueTable.createdAt,
      username: usersTable.username,
      firstName: usersTable.firstName,
    })
    .from(withdrawalQueueTable)
    .leftJoin(usersTable, eq(usersTable.telegramId, withdrawalQueueTable.telegramId))
    .where(eq(withdrawalQueueTable.status, "complete"))
    .orderBy(desc(withdrawalQueueTable.createdAt))
    .limit(100);

  const items = rows
    .map((row): FeedRow => ({
      type: "withdrawal",
      name: safeName(row.firstName, row.username, row.telegramId),
      amountUsd: Number(row.netUsd ?? 0),
      network: row.payoutNetwork === "usdt_ton" ? "USDT TON" : "USDT",
      createdAt: row.createdAt,
    }))
    .filter((row): row is FeedRow => row.amountUsd > 0);

  res.json({ items });
});

export default router;

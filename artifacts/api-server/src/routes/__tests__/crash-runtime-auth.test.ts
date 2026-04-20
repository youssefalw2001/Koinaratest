import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import express from "express";
import request from "supertest";
import { db, usersTable, crashRoundsTable, crashBetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createRoundFromStart } from "../../lib/crashRuntime";

const TEST_BOT_TOKEN = "test_bot_token_12345";
const VICTIM_TG_ID = "7777001";
const ATTACKER_TG_ID = "7777002";

function makeInitData(userId: string, botToken: string): string {
  const user = JSON.stringify({ id: Number(userId), first_name: "Test" });
  const params = new URLSearchParams({ user, auth_date: "1700000000" });
  const checkStr = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(checkStr).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("Crash auth and idempotent cashout", () => {
  let app: ReturnType<typeof express>;
  let testRoundId = 0;

  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;
    const { default: crashRouter } = await import("../crash");
    app = express();
    app.use(express.json());
    app.use(crashRouter);

    await db
      .insert(usersTable)
      .values([
        {
          telegramId: VICTIM_TG_ID,
          username: "victim_crash",
          tradeCredits: 10_000,
          goldCoins: 1_000,
        },
        {
          telegramId: ATTACKER_TG_ID,
          username: "attacker_crash",
          tradeCredits: 10_000,
          goldCoins: 1_000,
        },
      ])
      .onConflictDoNothing();

    const now = Date.now();
    const template = createRoundFromStart(new Date(now - 30_000));
    const [round] = await db
      .insert(crashRoundsTable)
      .values({
        phase: "running",
        houseEdge: 0.12,
        seedHash: template.seedHash,
        revealedSeed: template.revealedSeed,
        crashMultiplier: 5,
        bettingOpensAt: new Date(now - 30_000),
        bettingClosesAt: new Date(now - 26_000),
        runningStartedAt: new Date(now - 1_000),
        crashAt: new Date(now + 8_000),
      })
      .returning();
    testRoundId = round.id;

    await db.insert(crashBetsTable).values({
      roundId: testRoundId,
      telegramId: VICTIM_TG_ID,
      amountTc: 100,
      status: "pending",
    });
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await db.delete(crashBetsTable).where(eq(crashBetsTable.roundId, testRoundId));
    await db.delete(crashRoundsTable).where(eq(crashRoundsTable.id, testRoundId));
    await db.delete(usersTable).where(eq(usersTable.telegramId, VICTIM_TG_ID));
    await db.delete(usersTable).where(eq(usersTable.telegramId, ATTACKER_TG_ID));
  });

  it("rejects crash bet with mismatched Telegram init data", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .post("/crash/bet")
      .set("x-telegram-init-data", attackerInitData)
      .send({ telegramId: VICTIM_TG_ID, amountTc: 50 });
    expect(res.status).toBe(403);
  });

  it("returns replay-safe response for duplicate cashout with same idempotency key", async () => {
    const victimInitData = makeInitData(VICTIM_TG_ID, TEST_BOT_TOKEN);
    const key = `test-cashout:${testRoundId}:${Date.now()}`;

    const first = await request(app)
      .post("/crash/cashout")
      .set("x-telegram-init-data", victimInitData)
      .set("Idempotency-Key", key)
      .send({ telegramId: VICTIM_TG_ID, roundId: testRoundId });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/crash/cashout")
      .set("x-telegram-init-data", victimInitData)
      .set("Idempotency-Key", key)
      .send({ telegramId: VICTIM_TG_ID, roundId: testRoundId });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});

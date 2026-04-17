import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import express from "express";
import request from "supertest";
import { db, usersTable, withdrawalQueueTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const TEST_BOT_TOKEN = "test_bot_token_12345";
const VICTIM_TG_ID = "9999001";
const ATTACKER_TG_ID = "9999002";

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

describe("Withdrawal authz — IDOR prevention", () => {
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

    const { default: withdrawalsRouter } = await import("../withdrawals");
    app = express();
    app.use(express.json());
    app.use(withdrawalsRouter);

    await db.insert(usersTable).values([
      { telegramId: VICTIM_TG_ID, username: "victim", tradeCredits: 1000, goldCoins: 50000 },
      { telegramId: ATTACKER_TG_ID, username: "attacker", tradeCredits: 1000, goldCoins: 50000 },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await db.delete(usersTable).where(eq(usersTable.telegramId, VICTIM_TG_ID));
    await db.delete(usersTable).where(eq(usersTable.telegramId, ATTACKER_TG_ID));
    await db.delete(withdrawalQueueTable).where(eq(withdrawalQueueTable.telegramId, VICTIM_TG_ID));
  });

  it("rejects GET /withdrawals/:telegramId without initData header", async () => {
    const res = await request(app).get(`/withdrawals/${VICTIM_TG_ID}`);
    expect(res.status).toBe(401);
  });

  it("rejects GET /withdrawals/:telegramId with attacker's initData for victim's route", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/withdrawals/${VICTIM_TG_ID}`)
      .set("x-telegram-init-data", attackerInitData);
    expect(res.status).toBe(403);
  });

  it("allows GET /withdrawals/:telegramId with correct initData", async () => {
    const victimInitData = makeInitData(VICTIM_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/withdrawals/${VICTIM_TG_ID}`)
      .set("x-telegram-init-data", victimInitData);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.withdrawals)).toBe(true);
  });

  it("rejects POST /withdrawals/request without initData header", async () => {
    const res = await request(app)
      .post("/withdrawals/request")
      .send({ telegramId: VICTIM_TG_ID, gcAmount: 10000, usdtWallet: "T" + "A".repeat(33) });
    expect(res.status).toBe(401);
  });

  it("rejects POST /withdrawals/request with attacker's initData targeting victim", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .post("/withdrawals/request")
      .set("x-telegram-init-data", attackerInitData)
      .send({ telegramId: VICTIM_TG_ID, gcAmount: 10000, usdtWallet: "T" + "A".repeat(33) });
    expect(res.status).toBe(403);
  });

  it("rejects POST /withdrawals/verify-fee without initData header", async () => {
    const res = await request(app)
      .post("/withdrawals/verify-fee")
      .send({ telegramId: VICTIM_TG_ID, senderAddress: "UQAtest" });
    expect(res.status).toBe(401);
  });

  it("rejects POST /withdrawals/verify-fee with attacker's initData targeting victim", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .post("/withdrawals/verify-fee")
      .set("x-telegram-init-data", attackerInitData)
      .send({ telegramId: VICTIM_TG_ID, senderAddress: "UQAtest" });
    expect(res.status).toBe(403);
  });
});

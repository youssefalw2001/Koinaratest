import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import express from "express";
import request from "supertest";
import { db, usersTable, gemInventoryTable, contentSubmissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const TEST_BOT_TOKEN = "test_bot_token_12345";
const VICTIM_TG_ID = "8888001";
const ATTACKER_TG_ID = "8888002";

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

describe("Routes authz — IDOR prevention on gems/content/referrals", () => {
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    process.env.TELEGRAM_BOT_TOKEN = TEST_BOT_TOKEN;

    const { default: gemsRouter } = await import("../gems");
    const { default: contentRouter } = await import("../content");
    const { default: usersRouter } = await import("../users");

    app = express();
    app.use(express.json());
    app.use(gemsRouter);
    app.use(contentRouter);
    app.use(usersRouter);

    await db.insert(usersTable).values([
      {
        telegramId: VICTIM_TG_ID,
        username: "victim_r",
        tradeCredits: 10000,
        goldCoins: 0,
        vipExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        telegramId: ATTACKER_TG_ID,
        username: "attacker_r",
        tradeCredits: 0,
        goldCoins: 0,
      },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await db.delete(gemInventoryTable).where(eq(gemInventoryTable.telegramId, VICTIM_TG_ID));
    await db.delete(contentSubmissionsTable).where(eq(contentSubmissionsTable.telegramId, VICTIM_TG_ID));
    await db.delete(contentSubmissionsTable).where(eq(contentSubmissionsTable.telegramId, ATTACKER_TG_ID));
    await db.delete(usersTable).where(eq(usersTable.telegramId, VICTIM_TG_ID));
    await db.delete(usersTable).where(eq(usersTable.telegramId, ATTACKER_TG_ID));
  });

  // ─── /gems/purchase ──────────────────────────────────────────────────────
  it("rejects POST /gems/purchase without initData", async () => {
    const res = await request(app)
      .post("/gems/purchase")
      .send({ telegramId: VICTIM_TG_ID, gemType: "starter_boost" });
    expect(res.status).toBe(401);
  });

  it("rejects POST /gems/purchase with attacker initData targeting victim (prevents TC debit)", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .post("/gems/purchase")
      .set("x-telegram-init-data", attackerInitData)
      .send({ telegramId: VICTIM_TG_ID, gemType: "starter_boost" });
    expect(res.status).toBe(403);

    // Confirm victim's TC was NOT debited
    const [victim] = await db
      .select({ tc: usersTable.tradeCredits })
      .from(usersTable)
      .where(eq(usersTable.telegramId, VICTIM_TG_ID));
    expect(victim?.tc).toBe(10000);
  });

  // ─── /gems/:telegramId/active ────────────────────────────────────────────
  it("rejects GET /gems/:telegramId/active with attacker initData", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/gems/${VICTIM_TG_ID}/active`)
      .set("x-telegram-init-data", attackerInitData);
    expect(res.status).toBe(403);
  });

  // ─── /content/submit ─────────────────────────────────────────────────────
  it("rejects POST /content/submit without initData", async () => {
    const res = await request(app)
      .post("/content/submit")
      .send({ telegramId: VICTIM_TG_ID, platform: "tiktok", url: "https://tiktok.com/@x/video/1" });
    expect(res.status).toBe(401);
  });

  it("rejects POST /content/submit with attacker initData targeting victim", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .post("/content/submit")
      .set("x-telegram-init-data", attackerInitData)
      .send({ telegramId: VICTIM_TG_ID, platform: "tiktok", url: "https://tiktok.com/@x/video/1" });
    expect(res.status).toBe(403);
  });

  // ─── /content/:telegramId ────────────────────────────────────────────────
  it("rejects GET /content/:telegramId with attacker initData", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/content/${VICTIM_TG_ID}`)
      .set("x-telegram-init-data", attackerInitData);
    expect(res.status).toBe(403);
  });

  // ─── /users/:telegramId/referrals ────────────────────────────────────────
  it("rejects GET /users/:telegramId/referrals without initData", async () => {
    const res = await request(app).get(`/users/${VICTIM_TG_ID}/referrals`);
    expect(res.status).toBe(401);
  });

  it("rejects GET /users/:telegramId/referrals with attacker initData targeting victim", async () => {
    const attackerInitData = makeInitData(ATTACKER_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/users/${VICTIM_TG_ID}/referrals`)
      .set("x-telegram-init-data", attackerInitData);
    expect(res.status).toBe(403);
  });

  it("allows GET /users/:telegramId/referrals with correct initData", async () => {
    const victimInitData = makeInitData(VICTIM_TG_ID, TEST_BOT_TOKEN);
    const res = await request(app)
      .get(`/users/${VICTIM_TG_ID}/referrals`)
      .set("x-telegram-init-data", victimInitData);
    expect(res.status).toBe(200);
  });
});

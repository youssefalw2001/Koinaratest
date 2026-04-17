import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { db, usersTable, vipTxHashesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import usersRouter from "../users.js";

const TEST_TELEGRAM_ID = "__vip_test_user__";
const MOCK_SENDER = "EQBtest123sender";
const MOCK_OPERATOR_RAW = "0:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const MOCK_TX_HASH = "abcdef1234567890";

const app = express();
app.use(express.json());
app.use("/", usersRouter);

async function buildFetchMock(plan: "weekly" | "monthly") {
  const nanoValue = plan === "weekly" ? 500000000 : 1500000000;
  return vi.fn(async (url: string) => {
    const u = url.toString();
    if (u.includes("/accounts/") && !u.includes("/transactions")) {
      return {
        ok: true,
        json: async () => ({ address: MOCK_OPERATOR_RAW }),
      };
    }
    if (u.includes("/transactions")) {
      return {
        ok: true,
        json: async () => ({
          transactions: [
            {
              hash: MOCK_TX_HASH,
              out_msgs: [
                {
                  destination: { address: MOCK_OPERATOR_RAW },
                  value: nanoValue,
                },
              ],
            },
          ],
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
}

beforeAll(async () => {
  await db.delete(vipTxHashesTable).where(eq(vipTxHashesTable.txHash, MOCK_TX_HASH));
  await db.delete(usersTable).where(eq(usersTable.telegramId, TEST_TELEGRAM_ID));
  await db.insert(usersTable).values({
    telegramId: TEST_TELEGRAM_ID,
    username: "vip_test",
    tradeCredits: 1000,
    goldCoins: 0,
    totalGcEarned: 0,
    registrationDate: new Date().toISOString().split("T")[0],
  });
  process.env.KOINARA_TON_WALLET = "UQtest_operator_wallet";
});

afterAll(async () => {
  await db.delete(vipTxHashesTable).where(eq(vipTxHashesTable.txHash, MOCK_TX_HASH));
  await db.delete(usersTable).where(eq(usersTable.telegramId, TEST_TELEGRAM_ID));
  delete process.env.KOINARA_TON_WALLET;
});

beforeEach(async () => {
  await db.delete(vipTxHashesTable).where(eq(vipTxHashesTable.txHash, MOCK_TX_HASH));
  await db
    .update(usersTable)
    .set({ isVip: false, vipPlan: null, vipExpiresAt: null })
    .where(eq(usersTable.telegramId, TEST_TELEGRAM_ID));
  vi.restoreAllMocks();
});

describe("POST /users/:telegramId/vip — TON payment plans", () => {
  it("activates weekly VIP when a valid TON payment is found on-chain", async () => {
    vi.stubGlobal("fetch", await buildFetchMock("weekly"));

    const res = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "weekly", senderAddress: MOCK_SENDER });

    expect(res.status).toBe(200);
    expect(res.body.isVip).toBe(true);
    expect(res.body.vipPlan).toBe("ton_weekly");
    expect(res.body.vipExpiresAt).toBeTruthy();
    const expiresAt = new Date(res.body.vipExpiresAt).getTime();
    const nowPlus6Days = Date.now() + 6 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(nowPlus6Days);
  });

  it("activates monthly VIP when a valid TON payment is found on-chain", async () => {
    vi.stubGlobal("fetch", await buildFetchMock("monthly"));

    const res = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "monthly", senderAddress: MOCK_SENDER });

    expect(res.status).toBe(200);
    expect(res.body.isVip).toBe(true);
    expect(res.body.vipPlan).toBe("ton_monthly");
    const expiresAt = new Date(res.body.vipExpiresAt).getTime();
    const nowPlus29Days = Date.now() + 29 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(nowPlus29Days);
  });

  it("rejects when no matching transaction is found", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes("/accounts/") && !u.includes("/transactions")) {
        return { ok: true, json: async () => ({ address: MOCK_OPERATOR_RAW }) };
      }
      return { ok: true, json: async () => ({ transactions: [] }) };
    }));

    const res = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "weekly", senderAddress: MOCK_SENDER });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No matching TON payment/);
  });

  it("rejects duplicate transaction hash (double-spend prevention)", async () => {
    vi.stubGlobal("fetch", await buildFetchMock("weekly"));

    const first = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "weekly", senderAddress: MOCK_SENDER });
    expect(first.status).toBe(200);

    await db
      .update(usersTable)
      .set({ isVip: false, vipPlan: null, vipExpiresAt: null })
      .where(eq(usersTable.telegramId, TEST_TELEGRAM_ID));

    vi.stubGlobal("fetch", await buildFetchMock("weekly"));
    const second = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "weekly", senderAddress: MOCK_SENDER });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already been used/);
  });

  it("returns 400 when senderAddress is missing for a TON plan", async () => {
    const res = await request(app)
      .post(`/users/${TEST_TELEGRAM_ID}/vip`)
      .send({ plan: "weekly" });

    expect(res.status).toBe(400);
  });
});

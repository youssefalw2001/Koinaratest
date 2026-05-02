import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, userEventsTable, usersTable } from "@workspace/db";
import { resolveAuthenticatedTelegramId } from "../lib/telegramAuth";
import { serializeRows } from "../lib/serialize";

const router: IRouter = Router();

const PUBLIC_EVENTS = new Set(["app_open", "auth_failed", "account_bootstrap_failed"]);
const EVENT_RE = /^[a-z0-9_:.:-]{2,80}$/i;

const EventBody = z.object({
  telegramId: z.string().optional().nullable(),
  eventType: z.string().min(2).max(80).regex(EVENT_RE),
  source: z.string().max(120).optional().nullable(),
  sessionId: z.string().max(120).optional().nullable(),
  route: z.string().max(160).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

async function ensureAnalyticsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_events (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT,
      event_type TEXT NOT NULL,
      source TEXT,
      session_id TEXT,
      route TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_events_telegram_id_idx ON user_events (telegram_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_events_event_type_idx ON user_events (event_type)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_events_created_at_idx ON user_events (created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS user_events_source_idx ON user_events (source)`);
}

function safeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set(["initData", "hash", "token", "botToken", "walletPrivateKey", "privateKey"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (blocked.has(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 300);
    else if (typeof value === "number" || typeof value === "boolean" || value == null) out[key] = value;
    else out[key] = JSON.parse(JSON.stringify(value)).toString?.().slice?.(0, 300) ?? "[object]";
  }
  return out;
}

router.post("/analytics/event", async (req, res): Promise<void> => {
  const parsed = EventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid analytics event" });
    return;
  }

  const { eventType, source, sessionId, route } = parsed.data;
  let telegramId: string | null = null;

  if (parsed.data.telegramId) {
    const authedId = resolveAuthenticatedTelegramId(req, res, parsed.data.telegramId);
    if (!authedId) return;
    telegramId = authedId;
  } else if (!PUBLIC_EVENTS.has(eventType)) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const metadata = safeMetadata(parsed.data.metadata ?? {});
  await ensureAnalyticsTable();

  await db.insert(userEventsTable).values({
    telegramId,
    eventType,
    source: source ?? null,
    sessionId: sessionId ?? null,
    route: route ?? null,
    metadata,
  });

  if (telegramId) {
    await db.update(usersTable).set({ updatedAt: new Date() }).where(eq(usersTable.telegramId, telegramId));
  }

  res.status(201).json({ success: true });
});

router.get("/analytics/recent", async (req, res): Promise<void> => {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  const requestedId = typeof req.query.telegramId === "string" ? req.query.telegramId : "";
  if (!ownerId || requestedId !== ownerId) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  const authedId = resolveAuthenticatedTelegramId(req, res, requestedId);
  if (!authedId) return;

  await ensureAnalyticsTable();
  const rows = await db
    .select()
    .from(userEventsTable)
    .where(gte(userEventsTable.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
    .orderBy(desc(userEventsTable.createdAt))
    .limit(100);
  res.json({ events: serializeRows(rows as Record<string, unknown>[]) });
});

router.get("/analytics/summary", async (req, res): Promise<void> => {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  const requestedId = typeof req.query.telegramId === "string" ? req.query.telegramId : "";
  if (!ownerId || requestedId !== ownerId) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  const authedId = resolveAuthenticatedTelegramId(req, res, requestedId);
  if (!authedId) return;

  await ensureAnalyticsTable();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const newUsers = await db.select({ count: sql<number>`count(*)::int` }).from(usersTable).where(gte(usersTable.createdAt, since));
  const activeUsers = await db.select({ count: sql<number>`count(distinct ${userEventsTable.telegramId})::int` }).from(userEventsTable).where(and(gte(userEventsTable.createdAt, since), sql`${userEventsTable.telegramId} IS NOT NULL`));
  const eventTypes = await db.select({ eventType: userEventsTable.eventType, count: sql<number>`count(*)::int` }).from(userEventsTable).where(gte(userEventsTable.createdAt, since)).groupBy(userEventsTable.eventType).orderBy(desc(sql`count(*)`)).limit(30);
  const sources = await db.select({ source: userEventsTable.source, count: sql<number>`count(*)::int` }).from(userEventsTable).where(and(gte(userEventsTable.createdAt, since), sql`${userEventsTable.source} IS NOT NULL`)).groupBy(userEventsTable.source).orderBy(desc(sql`count(*)`)).limit(20);

  res.json({
    window: "24h",
    newUsers: Number(newUsers[0]?.count ?? 0),
    activeUsers: Number(activeUsers[0]?.count ?? 0),
    eventTypes,
    sources,
  });
});

export default router;

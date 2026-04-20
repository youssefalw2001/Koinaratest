import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getRedisClient } from "./redisClient";

type CheckStatus = "up" | "down" | "degraded";

export type SystemHealthReport = {
  ok: boolean;
  status: "ready" | "degraded" | "not_ready";
  timestamp: string;
  checks: {
    db: {
      status: CheckStatus;
      latencyMs: number;
      error?: string;
    };
    redis: {
      status: CheckStatus;
      latencyMs: number;
      enabled: boolean;
      error?: string;
    };
  };
};

function elapsedMs(start: number): number {
  return Math.max(0, Number((performance.now() - start).toFixed(2)));
}

export async function getSystemHealth(): Promise<SystemHealthReport> {
  const dbStart = performance.now();
  let dbStatus: CheckStatus = "up";
  let dbError: string | undefined;
  let dbLatencyMs = 0;
  try {
    await db.execute(sql`select 1`);
    dbLatencyMs = elapsedMs(dbStart);
  } catch (err) {
    dbLatencyMs = elapsedMs(dbStart);
    dbStatus = "down";
    dbError = err instanceof Error ? err.message : "Database health check failed";
  }

  const redisEnabled = Boolean(process.env.REDIS_URL?.trim());
  const redisStart = performance.now();
  let redisStatus: CheckStatus = redisEnabled ? "up" : "degraded";
  let redisError: string | undefined;
  let redisLatencyMs = 0;
  try {
    const redis = await getRedisClient();
    if (redisEnabled) {
      if (!redis) {
        redisStatus = "degraded";
        redisError = "REDIS_URL configured but Redis client unavailable";
      } else {
        await redis.ping();
      }
    }
    redisLatencyMs = elapsedMs(redisStart);
  } catch (err) {
    redisLatencyMs = elapsedMs(redisStart);
    redisStatus = "degraded";
    redisError = err instanceof Error ? err.message : "Redis health check failed";
  }

  let status: SystemHealthReport["status"] = "ready";
  if (dbStatus === "down") {
    status = "not_ready";
  } else if (redisStatus !== "up") {
    status = "degraded";
  }

  return {
    ok: status !== "not_ready",
    status,
    timestamp: new Date().toISOString(),
    checks: {
      db: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        error: dbError,
      },
      redis: {
        status: redisStatus,
        latencyMs: redisLatencyMs,
        enabled: redisEnabled,
        error: redisError,
      },
    },
  };
}

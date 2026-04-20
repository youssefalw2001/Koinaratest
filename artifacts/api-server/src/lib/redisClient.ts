import { createClient } from "redis";
import { logger } from "./logger";

type RedisClient = ReturnType<typeof createClient>;

let redisClientPromise: Promise<RedisClient | null> | null = null;
let redisDisabledLogged = false;

function getRedisUrl(): string | null {
  const raw = process.env.REDIS_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

export async function getRedisClient(): Promise<RedisClient | null> {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    if (!redisDisabledLogged) {
      logger.info("REDIS_URL not set — using in-memory fallback.");
      redisDisabledLogged = true;
    }
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy(retries) {
            return Math.min(200 + retries * 100, 2_000);
          },
        },
      });

      client.on("error", (err) => {
        logger.warn({ err }, "Redis client error");
      });

      try {
        await client.connect();
        logger.info("Redis connection established.");
        return client;
      } catch (err) {
        logger.error({ err }, "Failed to connect to Redis, falling back to memory");
        redisClientPromise = null;
        return null;
      }
    })();
  }

  return redisClientPromise;
}

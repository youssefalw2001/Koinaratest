import type { NextFunction, Request, Response } from "express";
import { getRedisClient } from "./redisClient";
import { logger } from "./logger";

interface RateRule {
  name: string;
  methods: Set<string>;
  path: RegExp;
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateCheckResult {
  allowed: boolean;
  retryInSec: number;
}

const RULES: RateRule[] = [
  {
    name: "users-register",
    methods: new Set(["POST"]),
    path: /^\/api\/users\/register$/,
    limit: 20,
    windowMs: 60_000,
  },
  {
    name: "battles-create",
    methods: new Set(["POST"]),
    path: /^\/api\/battles\/create$/,
    limit: 20,
    windowMs: 60_000,
  },
  {
    name: "battles-cancel",
    methods: new Set(["POST"]),
    path: /^\/api\/battles\/cancel$/,
    limit: 15,
    windowMs: 60_000,
  },
  {
    name: "battles-status",
    methods: new Set(["GET"]),
    path: /^\/api\/battles\/(active|status\/[^/]+)$/,
    limit: 180,
    windowMs: 60_000,
  },
  {
    name: "battles-read",
    methods: new Set(["GET"]),
    path: /^\/api\/battles\/(waiting\/[^/]+|recent|leaderboard)$/,
    limit: 120,
    windowMs: 60_000,
  },
  {
    name: "predictions-create",
    methods: new Set(["POST"]),
    path: /^\/api\/predictions$/,
    limit: 30,
    windowMs: 60_000,
  },
  {
    name: "predictions-resolve",
    methods: new Set(["POST"]),
    path: /^\/api\/predictions\/\d+\/resolve$/,
    limit: 45,
    windowMs: 60_000,
  },
  {
    name: "rewards-ad",
    methods: new Set(["POST"]),
    path: /^\/api\/rewards\/ad$/,
    limit: 20,
    windowMs: 60_000,
  },
  {
    name: "gems-purchase",
    methods: new Set(["POST"]),
    path: /^\/api\/gems\/purchase$/,
    limit: 30,
    windowMs: 60_000,
  },
  {
    name: "withdrawals-request",
    methods: new Set(["POST"]),
    path: /^\/api\/withdrawals\/request$/,
    limit: 10,
    windowMs: 5 * 60_000,
  },
  {
    name: "api-write-default",
    methods: new Set(["POST", "PUT", "PATCH", "DELETE"]),
    path: /^\/api\//,
    limit: 120,
    windowMs: 60_000,
  },
  {
    name: "api-read-default",
    methods: new Set(["GET"]),
    path: /^\/api\//,
    limit: 900,
    windowMs: 60_000,
  },
];

const buckets = new Map<string, Bucket>();
let redisFallbackLogged = false;

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip || "unknown";
}

function checkRuleInMemory(req: Request, rule: RateRule): RateCheckResult {
  const ip = getClientIp(req);
  const key = `${rule.name}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, retryInSec: Math.ceil(rule.windowMs / 1000) };
  }

  if (bucket.count >= rule.limit) {
    return { allowed: false, retryInSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { allowed: true, retryInSec: Math.ceil((bucket.resetAt - now) / 1000) };
}

async function checkRuleWithRedis(req: Request, rule: RateRule): Promise<RateCheckResult | null> {
  const redis = await getRedisClient();
  if (!redis) return null;

  const now = Date.now();
  const ip = getClientIp(req);
  const windowStart = now - (now % rule.windowMs);
  const resetAt = windowStart + rule.windowMs;
  const retryInSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
  const key = `ratelimit:${rule.name}:${ip}:${windowStart}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      const ttlMs = Math.max(1, resetAt - now);
      await redis.pExpire(key, ttlMs);
    }
    if (count > rule.limit) {
      return { allowed: false, retryInSec };
    }
    return { allowed: true, retryInSec };
  } catch (err) {
    if (!redisFallbackLogged) {
      logger.warn({ err }, "Redis rate limit check failed, using in-memory fallback.");
      redisFallbackLogged = true;
    }
    return null;
  }
}

async function checkRule(req: Request, rule: RateRule): Promise<RateCheckResult> {
  const redisResult = await checkRuleWithRedis(req, rule);
  if (redisResult) return redisResult;
  return checkRuleInMemory(req, rule);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref();

export async function apiRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const method = req.method.toUpperCase();
  const path = req.path;

  const matchedRules = RULES.filter((rule) => rule.methods.has(method) && rule.path.test(path));
  try {
    for (const rule of matchedRules) {
      const result = await checkRule(req, rule);
      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.retryInSec));
        res.status(429).json({
          error: `Too many requests. Retry in ${result.retryInSec}s.`,
        });
        return;
      }
    }
  } catch (err) {
    logger.error({ err }, "apiRateLimit failed unexpectedly");
  }

  next();
}

export function createRouteRateLimiter(
  name: string,
  config: { limit: number; windowMs: number; message?: string },
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const routeRule: RateRule = {
    name,
    methods: new Set(["POST", "PUT", "PATCH", "DELETE"]),
    path: /.*/,
    limit: config.limit,
    windowMs: config.windowMs,
  };

  return async (req, res, next): Promise<void> => {
    const method = req.method.toUpperCase();
    if (!routeRule.methods.has(method)) {
      next();
      return;
    }
    const result = await checkRule(req, routeRule);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryInSec));
      res.status(429).json({
        error: config.message ?? `Too many requests. Retry in ${result.retryInSec}s.`,
      });
      return;
    }
    next();
  };
}

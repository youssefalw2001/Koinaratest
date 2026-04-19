import type { NextFunction, Request, Response } from "express";

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

const RULES: RateRule[] = [
  {
    name: "users-register",
    methods: new Set(["POST"]),
    path: /^\/api\/users\/register$/,
    limit: 20,
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

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip || "unknown";
}

function checkRule(req: Request, rule: RateRule): { allowed: boolean; retryInSec: number } {
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

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref();

export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  const path = req.path;

  const matchedRules = RULES.filter((rule) => rule.methods.has(method) && rule.path.test(path));
  for (const rule of matchedRules) {
    const result = checkRule(req, rule);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryInSec));
      res.status(429).json({
        error: `Too many requests. Retry in ${result.retryInSec}s.`,
      });
      return;
    }
  }

  next();
}

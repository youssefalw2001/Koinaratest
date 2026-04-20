import { createHash } from "node:crypto";
import type { Request } from "express";
import { getRedisClient } from "./redisClient";
import { logger } from "./logger";

type IdempotencyState = "in_progress" | "completed";

type StoredIdempotencyRecord = {
  state: IdempotencyState;
  requestHash: string;
  statusCode: number | null;
  responseBody: unknown;
  expiresAt: number;
  updatedAt: number;
};

type BeginIdempotencyOptions = {
  scope: string;
  fallbackKey?: string;
  requireHeader?: boolean;
  ttlMs?: number;
  fingerprintData?: unknown;
};

type IdempotencyBaseResult = {
  key: string;
  source: "header" | "fallback";
};

export type IdempotencyBeginResult =
  | (IdempotencyBaseResult & {
      kind: "acquired";
      commit: (statusCode: number, responseBody: unknown) => Promise<void>;
      abort: () => Promise<void>;
    })
  | (IdempotencyBaseResult & {
      kind: "replay";
      statusCode: number;
      responseBody: unknown;
    })
  | (IdempotencyBaseResult & {
      kind: "in_progress" | "conflict";
      message: string;
    })
  | {
      kind: "missing";
      message: string;
    };

const DEFAULT_IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;
const IDEMPOTENCY_HEADER = "idempotency-key";
const inMemoryStore = new Map<string, StoredIdempotencyRecord>();
let redisFallbackLogged = false;

function sortedNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortedNormalize(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      normalized[key] = sortedNormalize(record[key]);
    }
    return normalized;
  }
  return value;
}

function asCanonicalJson(value: unknown): string {
  return JSON.stringify(sortedNormalize(value));
}

function makeToken(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function getHeaderKey(req: Request): string | null {
  const raw = req.header(IDEMPOTENCY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function __resetIdempotencyForTests(): void {
  inMemoryStore.clear();
}

function getRequestHash(req: Request, fingerprintData: unknown): string {
  const payload = {
    method: req.method.toUpperCase(),
    path: req.path,
    params: req.params,
    query: req.query,
    fingerprintData,
  };
  return createHash("sha256").update(asCanonicalJson(payload)).digest("hex");
}

function getMemoryRecord(key: string): StoredIdempotencyRecord | null {
  const record = inMemoryStore.get(key);
  if (!record) return null;
  if (record.expiresAt <= Date.now()) {
    inMemoryStore.delete(key);
    return null;
  }
  return record;
}

function setMemoryIfAbsent(key: string, value: StoredIdempotencyRecord): boolean {
  const existing = getMemoryRecord(key);
  if (existing) return false;
  inMemoryStore.set(key, value);
  return true;
}

function setMemoryRecord(key: string, value: StoredIdempotencyRecord): void {
  inMemoryStore.set(key, value);
}

function deleteMemoryRecord(key: string): void {
  inMemoryStore.delete(key);
}

async function getStoredRecord(key: string): Promise<StoredIdempotencyRecord | null> {
  const redis = await getRedisClient();
  if (!redis) return getMemoryRecord(key);

  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredIdempotencyRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= Date.now()) {
      await redis.del(key);
      return null;
    }
    return parsed;
  } catch (err) {
    if (!redisFallbackLogged) {
      logger.warn({ err }, "Idempotency Redis read failed, using in-memory fallback");
      redisFallbackLogged = true;
    }
    return getMemoryRecord(key);
  }
}

async function setIfAbsent(key: string, value: StoredIdempotencyRecord): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) return setMemoryIfAbsent(key, value);
  try {
    const ttlMs = Math.max(1, value.expiresAt - Date.now());
    const result = await redis.set(key, JSON.stringify(value), {
      PX: ttlMs,
      NX: true,
    });
    return result === "OK";
  } catch (err) {
    if (!redisFallbackLogged) {
      logger.warn({ err }, "Idempotency Redis write failed, using in-memory fallback");
      redisFallbackLogged = true;
    }
    return setMemoryIfAbsent(key, value);
  }
}

async function setRecord(key: string, value: StoredIdempotencyRecord): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    setMemoryRecord(key, value);
    return;
  }
  try {
    const ttlMs = Math.max(1, value.expiresAt - Date.now());
    await redis.set(key, JSON.stringify(value), { PX: ttlMs });
  } catch (err) {
    if (!redisFallbackLogged) {
      logger.warn({ err }, "Idempotency Redis update failed, using in-memory fallback");
      redisFallbackLogged = true;
    }
    setMemoryRecord(key, value);
  }
}

async function deleteRecord(key: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    deleteMemoryRecord(key);
    return;
  }
  try {
    await redis.del(key);
  } catch {
    deleteMemoryRecord(key);
  }
}

function toClientKey(scope: string, rawKey: string): string {
  return `idempotency:${scope}:${makeToken(rawKey)}`;
}

export async function beginIdempotency(
  req: Request,
  options: BeginIdempotencyOptions,
): Promise<IdempotencyBeginResult> {
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const headerKey = getHeaderKey(req);
  const selectedKey = headerKey ?? options.fallbackKey ?? null;
  if (!selectedKey) {
    return {
      kind: "missing",
      message: options.requireHeader
        ? "Idempotency-Key header is required for this endpoint."
        : "No idempotency key provided.",
    };
  }

  if (options.requireHeader && !headerKey) {
    return {
      kind: "missing",
      message: "Idempotency-Key header is required for this endpoint.",
    };
  }

  const key = toClientKey(options.scope, selectedKey);
  const source: "header" | "fallback" = headerKey ? "header" : "fallback";
  const requestHash = getRequestHash(req, options.fingerprintData ?? req.body);
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const existing = await getStoredRecord(key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return {
        kind: "conflict",
        key,
        source,
        message: "Idempotency key was already used with a different payload.",
      };
    }
    if (existing.state === "completed") {
      return {
        kind: "replay",
        key,
        source,
        statusCode: existing.statusCode ?? 200,
        responseBody: existing.responseBody,
      };
    }
    return {
      kind: "in_progress",
      key,
      source,
      message: "An identical request is still in progress. Retry shortly.",
    };
  }

  const inProgressRecord: StoredIdempotencyRecord = {
    state: "in_progress",
    requestHash,
    statusCode: null,
    responseBody: null,
    expiresAt,
    updatedAt: now,
  };

  const acquired = await setIfAbsent(key, inProgressRecord);
  if (!acquired) {
    const latest = await getStoredRecord(key);
    if (latest?.requestHash !== requestHash) {
      return {
        kind: "conflict",
        key,
        source,
        message: "Idempotency key was already used with a different payload.",
      };
    }
    if (latest?.state === "completed") {
      return {
        kind: "replay",
        key,
        source,
        statusCode: latest.statusCode ?? 200,
        responseBody: latest.responseBody,
      };
    }
    return {
      kind: "in_progress",
      key,
      source,
      message: "An identical request is still in progress. Retry shortly.",
    };
  }

  return {
    kind: "acquired",
    key,
    source,
    commit: async (statusCode, responseBody): Promise<void> => {
      const completedRecord: StoredIdempotencyRecord = {
        state: "completed",
        requestHash,
        statusCode,
        responseBody,
        expiresAt,
        updatedAt: Date.now(),
      };
      await setRecord(key, completedRecord);
    },
    abort: async (): Promise<void> => {
      const latest = await getStoredRecord(key);
      if (!latest) return;
      if (latest.requestHash !== requestHash) return;
      if (latest.state !== "in_progress") return;
      await deleteRecord(key);
    },
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of inMemoryStore.entries()) {
    if (value.expiresAt <= now) inMemoryStore.delete(key);
  }
}, 60_000).unref();

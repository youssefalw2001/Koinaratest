import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Request } from "express";
import { beginIdempotency, __resetIdempotencyForTests } from "../idempotency";
import * as redisClient from "../redisClient";

function makeRequest(input: {
  method?: string;
  path?: string;
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headerKey?: string;
}): Request {
  const key = input.headerKey;
  const req = {
    method: input.method ?? "POST",
    path: input.path ?? "/api/test",
    body: input.body ?? {},
    params: input.params ?? {},
    query: input.query ?? {},
    header(name: string) {
      if (name.toLowerCase() === "idempotency-key") {
        return key ?? null;
      }
      return null;
    },
  } as unknown as Request;
  return req;
}

describe("beginIdempotency", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    vi.restoreAllMocks();
    __resetIdempotencyForTests();
    vi.spyOn(redisClient, "getRedisClient").mockResolvedValue(null);
  });

  it("returns missing when header required but absent", async () => {
    const req = makeRequest({ body: { a: 1 } });
    const result = await beginIdempotency(req, {
      scope: "test.scope",
      requireHeader: true,
    });
    expect(result.kind).toBe("missing");
  });

  it("acquires and then replays completed response", async () => {
    const req = makeRequest({
      path: "/api/foo",
      body: { value: 10 },
      headerKey: "abc-123",
    });
    const first = await beginIdempotency(req, { scope: "test.scope" });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;

    await first.commit(200, { ok: true, value: 10 });

    const second = await beginIdempotency(req, { scope: "test.scope" });
    expect(second.kind).toBe("replay");
    if (second.kind !== "replay") return;
    expect(second.statusCode).toBe(200);
    expect(second.responseBody).toEqual({ ok: true, value: 10 });
  });

  it("returns conflict when same key reused with different payload", async () => {
    const reqA = makeRequest({
      path: "/api/foo",
      body: { value: 10 },
      headerKey: "same-key",
    });
    const reqB = makeRequest({
      path: "/api/foo",
      body: { value: 99 },
      headerKey: "same-key",
    });

    const first = await beginIdempotency(reqA, { scope: "test.scope" });
    expect(first.kind).toBe("acquired");
    if (first.kind !== "acquired") return;
    await first.commit(200, { ok: true });

    const second = await beginIdempotency(reqB, { scope: "test.scope" });
    expect(second.kind).toBe("conflict");
  });

  it("uses fallback key when header is absent", async () => {
    const req = makeRequest({ body: { value: 5 } });
    const result = await beginIdempotency(req, {
      scope: "test.scope",
      fallbackKey: "fallback-key-1",
    });
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") return;
    expect(result.source).toBe("fallback");
    await result.abort();
  });
});

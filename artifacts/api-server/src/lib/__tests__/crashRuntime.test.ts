import { describe, expect, it } from "vitest";
import {
  BETTING_PHASE_MS,
  CRASH_ROUND_DURATION_MS,
  getAuthoritativeRoundLiveState,
  normalizeCrashRoundPhase,
  type CrashRoundTimingInput,
} from "../crashRuntime";

function makeRound(input: Partial<CrashRoundTimingInput> = {}): CrashRoundTimingInput {
  const baseStart = new Date("2026-01-01T00:00:00.000Z");
  return {
    phase: input.phase ?? "pending",
    bettingClosesAt: input.bettingClosesAt ?? new Date(baseStart.getTime() + BETTING_PHASE_MS),
    runningStartedAt: input.runningStartedAt ?? new Date(baseStart.getTime() + BETTING_PHASE_MS),
    crashAt:
      input.crashAt ??
      new Date(baseStart.getTime() + BETTING_PHASE_MS + CRASH_ROUND_DURATION_MS),
    crashMultiplier: input.crashMultiplier ?? 3.25,
  };
}

describe("normalizeCrashRoundPhase", () => {
  it("maps legacy betting phase to pending", () => {
    expect(normalizeCrashRoundPhase("betting")).toBe("pending");
  });

  it("keeps known phases unchanged", () => {
    expect(normalizeCrashRoundPhase("pending")).toBe("pending");
    expect(normalizeCrashRoundPhase("running")).toBe("running");
    expect(normalizeCrashRoundPhase("crashed")).toBe("crashed");
    expect(normalizeCrashRoundPhase("settled")).toBe("settled");
  });
});

describe("getAuthoritativeRoundLiveState", () => {
  it("is pending before betting closes", () => {
    const round = makeRound();
    const now = new Date("2026-01-01T00:00:02.000Z").getTime();
    const live = getAuthoritativeRoundLiveState(round, now);
    expect(live.phase).toBe("pending");
    expect(live.multiplier).toBe(1);
    expect(live.crashed).toBe(false);
  });

  it("is running after betting closes and before crash", () => {
    const round = makeRound({
      crashMultiplier: 10,
      crashAt: new Date("2026-01-01T00:00:20.000Z"),
    });
    const now = new Date("2026-01-01T00:00:08.000Z").getTime();
    const live = getAuthoritativeRoundLiveState(round, now);
    expect(live.phase).toBe("running");
    expect(live.multiplier).toBeGreaterThan(1);
    expect(live.multiplier).toBeLessThan(round.crashMultiplier);
  });

  it("transitions to crashed at or past crashAt", () => {
    const round = makeRound({
      crashMultiplier: 4.5,
      crashAt: new Date("2026-01-01T00:00:12.000Z"),
    });
    const now = new Date("2026-01-01T00:00:12.000Z").getTime();
    const live = getAuthoritativeRoundLiveState(round, now);
    expect(live.phase).toBe("crashed");
    expect(live.multiplier).toBe(4.5);
    expect(live.crashed).toBe(true);
  });

  it("caps live multiplier at crash multiplier", () => {
    const round = makeRound({
      crashMultiplier: 1.5,
      crashAt: new Date("2026-01-01T00:00:20.000Z"),
    });
    const now = new Date("2026-01-01T00:00:15.000Z").getTime();
    const live = getAuthoritativeRoundLiveState(round, now);
    expect(live.multiplier).toBeLessThanOrEqual(1.5);
  });

  it("keeps settled phase sticky", () => {
    const round = makeRound({
      phase: "settled",
      crashMultiplier: 2.2,
    });
    const now = new Date("2026-01-01T00:00:06.000Z").getTime();
    const live = getAuthoritativeRoundLiveState(round, now);
    expect(live.phase).toBe("settled");
    expect(live.multiplier).toBe(2.2);
    expect(live.crashed).toBe(true);
  });
});

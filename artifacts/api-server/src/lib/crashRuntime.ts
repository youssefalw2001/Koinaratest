import crypto from "crypto";

export const CRASH_HOUSE_EDGE = 0.12;
export const CRASH_ROUND_DURATION_MS = 14_000;
export const BETTING_PHASE_MS = 4_000;
const MAX_CRASH_MULTIPLIER = 100;
const MIN_CRASH_DURATION_MS = 2_400;

const LOOP_STEP_MS = 100;
const roundCycleMs = CRASH_ROUND_DURATION_MS + BETTING_PHASE_MS;

let runtimeLoop: NodeJS.Timeout | null = null;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function randomSeedHex(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function calculateCrashPoint(seed: string, edge = CRASH_HOUSE_EDGE): number {
  const hash = sha256Hex(seed);
  const int52 = parseInt(hash.slice(0, 13), 16);
  // Use the max value representable by 13 hex chars (52 bits), not MAX_SAFE_INTEGER.
  // This keeps the crash-point distribution in the intended playable range.
  const max = 0xFFFFFFFFFFFFF;
  const u = Math.min(Math.max(int52 / max, 1e-12), 0.999999999999);
  const x = (1 - edge) / (1 - u);
  return Number(Math.min(Math.max(x, 1), MAX_CRASH_MULTIPLIER).toFixed(2));
}

export function getCurrentRoundStart(referenceMs = Date.now()): Date {
  const startMs = Math.floor(referenceMs / roundCycleMs) * roundCycleMs;
  return new Date(startMs);
}

export function getRoundCycleMs(): number {
  return roundCycleMs;
}

export function createRoundFromStart(start: Date) {
  const bettingOpensAt = new Date(start.getTime());
  const bettingClosesAt = new Date(start.getTime() + BETTING_PHASE_MS);
  const runningStartedAt = new Date(bettingClosesAt.getTime());
  const revealedSeed = randomSeedHex();
  const seedHash = sha256Hex(revealedSeed);
  const crashMultiplier = calculateCrashPoint(revealedSeed);
  const crashDelaySec = getCrashDurationSec(crashMultiplier);
  const crashAt = new Date(
    runningStartedAt.getTime() +
      Math.round(Math.min(crashDelaySec, CRASH_ROUND_DURATION_MS / 1000) * 1000),
  );

  return {
    bettingOpensAt,
    bettingClosesAt,
    runningStartedAt,
    crashAt,
    revealedSeed,
    seedHash,
    crashMultiplier,
  };
}

export function getCrashMultiplierAtElapsedSec(elapsedSec: number): number {
  const clamped = Math.max(0, elapsedSec);
  // Fast curve to feel "godly" while still deterministic.
  const value = 1 + 0.75 * clamped + 0.06 * clamped * clamped;
  return Number(Math.min(Math.max(value, 1), MAX_CRASH_MULTIPLIER).toFixed(2));
}

export function getElapsedSecForMultiplier(targetMultiplier: number): number {
  if (!Number.isFinite(targetMultiplier) || targetMultiplier <= 1) return 0;
  // Invert: m = 1 + 0.75t + 0.06t^2
  const a = 0.06;
  const b = 0.75;
  const c = 1 - targetMultiplier;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return Math.max(0, t);
}

export function getCrashDurationSec(crashMultiplier: number): number {
  const safe = Math.max(1, crashMultiplier);
  const baseSec = 2.4 + Math.log2(safe) * 2.6;
  const clampedSec = Math.min(
    CRASH_ROUND_DURATION_MS / 1000,
    Math.max(MIN_CRASH_DURATION_MS / 1000, baseSec),
  );
  return Number(clampedSec.toFixed(3));
}

export function getCrashMultiplierAtElapsedForRound(
  elapsedSec: number,
  crashMultiplier: number,
  roundDurationSec: number,
): number {
  if (!Number.isFinite(roundDurationSec) || roundDurationSec <= 0) {
    return Number(Math.max(1, crashMultiplier).toFixed(2));
  }
  const progress = Math.max(0, Math.min(1, elapsedSec / roundDurationSec));
  const eased = Math.pow(progress, 1.35);
  const value = 1 + (Math.max(1, crashMultiplier) - 1) * eased;
  return Number(Math.min(value, Math.max(1, crashMultiplier)).toFixed(2));
}

export function startCrashRuntimeLoop(): void {
  if (runtimeLoop) return;
  runtimeLoop = setInterval(() => {
    // The router computes and settles state on demand.
    // This heartbeat keeps timing behavior centralized for future extensions.
  }, LOOP_STEP_MS);
}

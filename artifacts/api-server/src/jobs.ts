import { cancelExpiredWaitingBattles, resolveDueBattles, restoreStuckResolvingBattles } from "./lib/battleLogic";
import { logger } from "./lib/logger";

let started = false;
let running = false;
let lastRunAt: Date | null = null;
let lastResolved = 0;
let lastCancelled = 0;
let lastRestored = 0;
let lastError: string | null = null;

export function getBattleJobStatus() {
  return {
    started,
    running,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastResolved,
    lastCancelled,
    lastRestored,
    lastError,
  };
}

export function startJobs(): void {
  if (started) return;
  started = true;

  const runBattleJobs = async () => {
    if (running) return;
    running = true;
    try {
      const restored = await restoreStuckResolvingBattles();
      const resolved = await resolveDueBattles();
      const cancelled = await cancelExpiredWaitingBattles();
      lastRunAt = new Date();
      lastResolved = resolved;
      lastCancelled = cancelled;
      lastRestored = restored;
      lastError = null;
      if (resolved || cancelled || restored) logger.info({ resolved, cancelled, restored }, "Battle jobs processed");
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown battle job error";
      logger.warn({ err }, "Battle jobs failed");
    } finally {
      running = false;
    }
  };

  void runBattleJobs();
  setInterval(() => void runBattleJobs(), 5_000).unref();
}

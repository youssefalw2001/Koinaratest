import { cancelExpiredWaitingBattles, resolveDueBattles } from "./lib/battleLogic";
import { logger } from "./lib/logger";

let started = false;

export function startJobs(): void {
  if (started) return;
  started = true;

  const runBattleJobs = async () => {
    try {
      const resolved = await resolveDueBattles();
      const cancelled = await cancelExpiredWaitingBattles();
      if (resolved || cancelled) logger.info({ resolved, cancelled }, "Battle jobs processed");
    } catch (err) {
      logger.warn({ err }, "Battle jobs failed");
    }
  };

  void runBattleJobs();
  setInterval(() => void runBattleJobs(), 5_000);
}

import { and, eq, lt } from "drizzle-orm";
import { db, predictionsTable } from "@workspace/db";
import { resolvePredictionLogic } from "./resolveLogic";
import { getBtcPrice } from "./btcPriceCache";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 30_000;
const STALE_AFTER_SEC = 75;

let started = false;

export function startAutoResolveSweeper(): void {
  if (started) return;
  started = true;

  const tick = async (): Promise<void> => {
    try {
      const cutoff = new Date(Date.now() - STALE_AFTER_SEC * 1000);
      const stale = await db
        .select()
        .from(predictionsTable)
        .where(
          and(eq(predictionsTable.status, "pending"), lt(predictionsTable.createdAt, cutoff)),
        )
        .limit(50);

      if (stale.length === 0) return;

      const exitPrice = await getBtcPrice();
      if (exitPrice === null) {
        logger.warn("Sweeper: no BTC price available, skipping cycle");
        return;
      }

      let resolved = 0;
      for (const pred of stale) {
        const out = await resolvePredictionLogic(pred.id, exitPrice, {
          autoResolved: true,
        });
        if (out.ok) resolved += 1;
      }
      if (resolved > 0) {
        logger.info({ resolved, scanned: stale.length }, "Auto-resolved stale predictions");
      }
    } catch (err) {
      logger.error({ err }, "Sweeper tick failed");
    }
  };

  setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);

  // Also run shortly after startup to handle anything stuck across restarts.
  setTimeout(() => {
    void tick();
  }, 5_000);
}

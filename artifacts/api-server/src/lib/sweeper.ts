import { and, eq } from "drizzle-orm";
import { db, predictionsTable } from "@workspace/db";
import { resolvePredictionLogic } from "./resolveLogic";
import { getBtcPrice } from "./btcPriceCache";
import { logger } from "./logger";

const SWEEP_INTERVAL_MS = 30_000;
// Grace window after the prediction's own duration elapses before we consider
// it abandoned and auto-resolve it. Must be >= the frontend's grace window so
// the client has a chance to resolve it first.
const STALE_GRACE_SEC = 15;

let started = false;

export function startAutoResolveSweeper(): void {
  if (started) return;
  started = true;

  const tick = async (): Promise<void> => {
    try {
      // Duration-aware: fetch all pending rows, then filter client-side against
      // each row's own `duration` + grace window. Cheaper than a per-duration
      // query and keeps the logic in one place.
      const pending = await db
        .select()
        .from(predictionsTable)
        .where(eq(predictionsTable.status, "pending"))
        .limit(200);

      const now = Date.now();
      const stale = pending.filter((p) => {
        const dur = p.duration ?? 60;
        const ageSec = (now - new Date(p.createdAt).getTime()) / 1000;
        return ageSec >= dur + STALE_GRACE_SEC;
      });

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

import app from "./app";
import { logger } from "./lib/logger";
import { startAutoResolveSweeper } from "./lib/sweeper";
import { startCrashRuntimeLoop } from "./lib/crashRuntime";
import { runStartupValidation } from "./lib/startupValidation";
import { approveMatureCrTransactions } from "./routes/commissions";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

runStartupValidation();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startAutoResolveSweeper();
  startCrashRuntimeLoop();

  // Run CR approval on startup to catch any transactions that matured while server was down
  approveMatureCrTransactions().catch((err) => logger.error({ err }, "Initial CR approval failed"));

  // Approve matured CR transactions every hour (48h hold → creators can withdraw after 48h)
  setInterval(async () => {
    try {
      const { approved } = await approveMatureCrTransactions();
      if (approved > 0) logger.info({ approved }, "Approved matured CR transactions");
    } catch (err) {
      logger.error({ err }, "CR approval job failed");
    }
  }, 60 * 60 * 1000);
});

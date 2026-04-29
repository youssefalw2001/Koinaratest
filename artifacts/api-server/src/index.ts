import app from "./app";
import { logger } from "./lib/logger";
import { startAutoResolveSweeper } from "./lib/sweeper";
import { startCrashRuntimeLoop } from "./lib/crashRuntime";
import { runStartupValidation } from "./lib/startupValidation";
import { runStartupMigrations } from "./lib/startupMigrations";

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

async function main() {
  await runStartupMigrations();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startAutoResolveSweeper();
    startCrashRuntimeLoop();
  });
}

main().catch((err) => {
  logger.error({ err }, "Server startup failed");
  process.exit(1);
});

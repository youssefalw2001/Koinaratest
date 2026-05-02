import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimit } from "./lib/rateLimit";
import { ensureCreatorMissionColumns } from "./lib/ensureCreatorMissionColumns";
import { ensureBattleTables } from "./lib/ensureBattleTables";
import { startJobs } from "./jobs";

const app: Express = express();

ensureCreatorMissionColumns().catch((err) => {
  logger.error({ err }, "Creator Missions startup migration failed");
});

ensureBattleTables().catch((err) => {
  logger.error({ err }, "Battle startup migration failed");
});

startJobs();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : ["http://localhost:5173", "http://localhost:4173"];
if (process.env.NODE_ENV === "production" && !process.env.CORS_ALLOWED_ORIGINS) {
  logger.warn("CORS_ALLOWED_ORIGINS is not set — API will only accept requests from localhost. Set this to your GitHub Pages URL in Railway.");
}
app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(apiRateLimit);

app.use("/api", router);

export default app;

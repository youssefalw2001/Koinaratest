import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { apiRateLimit } from "./lib/rateLimit";
import { ensureCreatorMissionColumns } from "./lib/ensureCreatorMissionColumns";
import { ensureAlphaMarketsTables } from "./lib/ensureAlphaMarketsTables";

const app: Express = express();

ensureCreatorMissionColumns().catch((err) => {
  logger.error({ err }, "Creator Missions startup migration failed");
});

ensureAlphaMarketsTables().catch((err) => {
  logger.error({ err }, "Alpha Markets startup migration failed");
});

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
  ? process.env.CORS_ALLOWED_ORIGINS.split(",")
  : ["http://localhost:5173", "http://localhost:4173"];
app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(apiRateLimit);

app.use("/api", router);

export default app;

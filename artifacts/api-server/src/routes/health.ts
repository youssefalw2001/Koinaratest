import { Router, type IRouter } from "express";
import { getSystemHealth } from "../lib/healthChecks";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/readyz", async (_req, res) => {
  const report = await getSystemHealth();
  const statusCode = report.ok ? 200 : 503;
  res.status(statusCode).json(report);
});

export default router;

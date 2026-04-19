import { Router, type IRouter } from "express";
import { getBtcPrice } from "../lib/btcPriceCache";

const router: IRouter = Router();

let simulatedPrice = 104_000;
let lastSimulatedAt = Date.now();

function getSimulatedPrice(): number {
  const now = Date.now();
  const elapsedSec = Math.max(1, (now - lastSimulatedAt) / 1000);
  lastSimulatedAt = now;
  const drift = (Math.random() - 0.48) * 24 * elapsedSec;
  simulatedPrice = Math.max(90_000, simulatedPrice + drift);
  return Number(simulatedPrice.toFixed(2));
}

router.get("/market/btc-price", async (_req, res): Promise<void> => {
  const livePrice = await getBtcPrice();
  if (livePrice !== null) {
    res.json({ price: livePrice, source: "live" });
    return;
  }
  res.json({ price: getSimulatedPrice(), source: "simulated" });
});

export default router;

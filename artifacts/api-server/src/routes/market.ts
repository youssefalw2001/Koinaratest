import { Router, type IRouter } from "express";
import {
  getBtcPrice,
  getSymbolPrice,
  SUPPORTED_SYMBOLS,
  type SupportedSymbol,
} from "../lib/btcPriceCache";

const router: IRouter = Router();

type SimState = { price: number; at: number };
const SIM_BASE: Record<SupportedSymbol, number> = {
  BTCUSDT: 104_000,
  ETHUSDT: 3_300,
  SOLUSDT: 180,
  BNBUSDT: 650,
  XRPUSDT: 2.2,
};
const simState = new Map<SupportedSymbol, SimState>();

function getSimulatedPrice(symbol: SupportedSymbol): number {
  const now = Date.now();
  const state = simState.get(symbol);
  const base = state?.price ?? SIM_BASE[symbol];
  const elapsedSec = state ? Math.max(1, (now - state.at) / 1000) : 1;
  // Volatility scales with price so cheap assets still move visibly.
  const vol = base * 0.0002;
  const drift = (Math.random() - 0.48) * vol * elapsedSec * 4;
  const next = Math.max(base * 0.5, base + drift);
  simState.set(symbol, { price: next, at: now });
  return Number(next.toFixed(symbol === "XRPUSDT" ? 4 : 2));
}

function isSupportedSymbol(s: string): s is SupportedSymbol {
  return (SUPPORTED_SYMBOLS as readonly string[]).includes(s);
}

router.get("/market/btc-price", async (_req, res): Promise<void> => {
  const livePrice = await getBtcPrice();
  if (livePrice !== null) {
    res.json({ price: livePrice, source: "live" });
    return;
  }
  res.json({ price: getSimulatedPrice("BTCUSDT"), source: "simulated" });
});

router.get("/market/price", async (req, res): Promise<void> => {
  const raw = String(req.query.symbol ?? "BTCUSDT").toUpperCase();
  if (!isSupportedSymbol(raw)) {
    res.status(400).json({
      error: `Unsupported symbol. Allowed: ${SUPPORTED_SYMBOLS.join(", ")}`,
    });
    return;
  }
  const live = await getSymbolPrice(raw);
  if (live !== null) {
    res.json({ symbol: raw, price: live, source: "live" });
    return;
  }
  res.json({ symbol: raw, price: getSimulatedPrice(raw), source: "simulated" });
});

router.get("/market/pairs", (_req, res): void => {
  res.json({ pairs: SUPPORTED_SYMBOLS });
});

export default router;

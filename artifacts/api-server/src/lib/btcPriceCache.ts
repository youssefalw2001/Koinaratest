import { logger } from "./logger";

const CACHE_MAX_AGE_MS = 1_500;

export const SUPPORTED_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "PAXGUSDT",
  "TONUSDT",
] as const;
export type SupportedSymbol = (typeof SUPPORTED_SYMBOLS)[number];

type CacheEntry = { price: number; at: number };
const cache = new Map<string, CacheEntry>();

/**
 * Fetch a symbol price from Binance REST with a hard timeout and a cached
 * fallback. Returns the cached value if the network call fails or times out.
 *
 * This endpoint is the single source of truth for price data — the Binance
 * REST fallback is always consulted when the live websocket feed is stale.
 */
export async function getSymbolPrice(symbol: SupportedSymbol): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(symbol);
  if (cached && now - cached.at < CACHE_MAX_AGE_MS) {
    return cached.price;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { price?: string };
    const price = data.price ? parseFloat(data.price) : NaN;
    if (Number.isFinite(price) && price > 0) {
      cache.set(symbol, { price, at: now });
      return price;
    }
    return cached?.price ?? null;
  } catch (err) {
    logger.warn({ err, symbol }, "Market price fetch failed — serving cache");
    return cached?.price ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible BTC/USDT accessor. */
export async function getBtcPrice(): Promise<number | null> {
  return getSymbolPrice("BTCUSDT");
}

import { logger } from "./logger";

let cachedPrice: number | null = null;
let cachedAt = 0;

const CACHE_MAX_AGE_MS = 30_000;

/**
 * Fetch the latest BTC/USDT price from Binance REST with a hard timeout.
 * Returns the cached value if the network call fails or times out.
 */
export async function getBtcPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedPrice !== null && now - cachedAt < CACHE_MAX_AGE_MS) {
    return cachedPrice;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
      { signal: controller.signal },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { price?: string };
    const price = data.price ? parseFloat(data.price) : NaN;
    if (Number.isFinite(price) && price > 0) {
      cachedPrice = price;
      cachedAt = now;
      return price;
    }
    return cachedPrice;
  } catch (err) {
    logger.warn({ err }, "BTC price fetch failed");
    return cachedPrice;
  } finally {
    clearTimeout(timer);
  }
}

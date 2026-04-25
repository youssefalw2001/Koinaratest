import { logger } from "./logger";

const CACHE_MAX_AGE_MS = 450;

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

const COINBASE_PAIR: Partial<Record<SupportedSymbol, string>> = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  SOLUSDT: "SOL-USD",
  BNBUSDT: "BNB-USD",
  XRPUSDT: "XRP-USD",
  PAXGUSDT: "PAXG-USD",
  TONUSDT: "TON-USD",
};

type CacheEntry = { price: number; at: number };
const cache = new Map<string, CacheEntry>();

async function fetchWithTimeout(url: string, timeoutMs = 2500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryBinance(symbol: SupportedSymbol): Promise<number | null> {
  for (const host of ["api.binance.com", "api1.binance.com", "api2.binance.com"]) {
    try {
      const res = await fetchWithTimeout(`https://${host}/api/v3/ticker/price?symbol=${symbol}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { price?: string };
      const price = data.price ? parseFloat(data.price) : NaN;
      if (Number.isFinite(price) && price > 0) return price;
    } catch {}
  }
  return null;
}

async function tryCoinbase(symbol: SupportedSymbol): Promise<number | null> {
  const pair = COINBASE_PAIR[symbol];
  if (!pair) return null;
  try {
    const res = await fetchWithTimeout(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { amount?: string } };
    const price = data.data?.amount ? parseFloat(data.data.amount) : NaN;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function getSymbolPrice(symbol: SupportedSymbol): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(symbol);
  if (cached && now - cached.at < CACHE_MAX_AGE_MS) {
    return cached.price;
  }

  const price = (await tryBinance(symbol)) ?? (await tryCoinbase(symbol));

  if (price !== null) {
    cache.set(symbol, { price, at: now });
    return price;
  }

  if (cached) {
    logger.warn({ symbol }, "All price sources failed — serving stale cache");
    return cached.price;
  }

  return null;
}

export async function getBtcPrice(): Promise<number | null> {
  return getSymbolPrice("BTCUSDT");
}

export async function fetchKlines(
  symbol: SupportedSymbol,
  interval: string,
  limit: number,
): Promise<any[][] | null> {
  for (const host of ["api.binance.com", "api1.binance.com", "api2.binance.com", "api3.binance.com"]) {
    try {
      const res = await fetchWithTimeout(
        `https://${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {}
  }
  return null;
}

export function generateSyntheticKlines(basePrice: number, count: number, intervalMs: number): any[][] {
  const now = Date.now();
  const vol = basePrice * 0.0001;

  const closes: number[] = [basePrice];
  for (let i = 1; i < count; i++) {
    const prev = closes[i - 1];
    const drift = (Math.random() - 0.5) * vol * 2;
    closes.push(Math.max(prev * 0.99, prev + drift));
  }
  closes.reverse();

  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const wick = Math.random() * vol * 0.5;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const time = now - (count - 1 - i) * intervalMs;
    return [time, open.toFixed(2), high.toFixed(2), low.toFixed(2), close.toFixed(2),
      "0", time + intervalMs - 1, "0", "0", "0", "0", "0"];
  });
}

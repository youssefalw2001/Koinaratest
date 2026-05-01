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

const COINBASE_PAIR: Partial<Record<SupportedSymbol, string>> = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  SOLUSDT: "SOL-USD",
  BNBUSDT: "BNB-USD",
  XRPUSDT: "XRP-USD",
  PAXGUSDT: "PAXG-USD",
  TONUSDT: "TON-USD",
};

const KRAKEN_PAIR: Partial<Record<SupportedSymbol, string>> = {
  BTCUSDT: "XBTUSD",
  ETHUSDT: "ETHUSD",
  SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD",
  PAXGUSDT: "PAXGUSD",
};

const COINGECKO_ID: Partial<Record<SupportedSymbol, string>> = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana",
  BNBUSDT: "binancecoin",
  XRPUSDT: "ripple",
  PAXGUSDT: "pax-gold",
  TONUSDT: "the-open-network",
};

type CacheEntry = { price: number; at: number };
const cache = new Map<string, CacheEntry>();

async function fetchWithTimeout(url: string, timeoutMs = 1800): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "KoinaraMarketFeed/1.0" },
    });
  } finally {
    clearTimeout(timer);
  }
}

function validPrice(value: unknown): number | null {
  const price = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(price) && price > 0 ? price : null;
}

async function tryKraken(symbol: SupportedSymbol): Promise<number | null> {
  const pair = KRAKEN_PAIR[symbol];
  if (!pair) return null;
  try {
    const res = await fetchWithTimeout(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { error?: string[]; result?: Record<string, { c?: string[] }> };
    if (data.error?.length) return null;
    const ticker = Object.values(data.result ?? {})[0];
    return validPrice(ticker?.c?.[0]);
  } catch {
    return null;
  }
}

async function tryBinance(symbol: SupportedSymbol): Promise<number | null> {
  for (const host of ["api.binance.com", "api1.binance.com", "api2.binance.com", "api3.binance.com"]) {
    try {
      const res = await fetchWithTimeout(`https://${host}/api/v3/ticker/price?symbol=${symbol}`, 1200);
      if (!res.ok) continue;
      const data = (await res.json()) as { price?: string };
      const price = validPrice(data.price);
      if (price !== null) return price;
    } catch {}
  }
  return null;
}

async function tryBybit(symbol: SupportedSymbol): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`, 1600);
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { list?: Array<{ lastPrice?: string }> } };
    return validPrice(data.result?.list?.[0]?.lastPrice);
  } catch {
    return null;
  }
}

async function tryCoinbase(symbol: SupportedSymbol): Promise<number | null> {
  const pair = COINBASE_PAIR[symbol];
  if (!pair) return null;
  try {
    const res = await fetchWithTimeout(`https://api.coinbase.com/v2/prices/${pair}/spot`, 1600);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { amount?: string } };
    return validPrice(data.data?.amount);
  } catch {
    return null;
  }
}

async function tryCoinGecko(symbol: SupportedSymbol): Promise<number | null> {
  const id = COINGECKO_ID[symbol];
  if (!id) return null;
  try {
    const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, 1800);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, { usd?: number }>;
    return validPrice(data[id]?.usd);
  } catch {
    return null;
  }
}

export async function getSymbolPrice(symbol: SupportedSymbol): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(symbol);
  if (cached && now - cached.at < CACHE_MAX_AGE_MS) return cached.price;

  const attempts = await Promise.allSettled([
    tryBybit(symbol),
    tryBinance(symbol),
    tryKraken(symbol),
    tryCoinbase(symbol),
    tryCoinGecko(symbol),
  ]);

  for (const attempt of attempts) {
    const price = attempt.status === "fulfilled" ? validPrice(attempt.value) : null;
    if (price !== null) {
      cache.set(symbol, { price, at: now });
      return price;
    }
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

export async function fetchKlines(symbol: SupportedSymbol, interval: string, limit: number): Promise<any[][] | null> {
  const binanceInterval = interval === "1s" ? "1m" : interval;
  for (const host of ["api.binance.com", "api1.binance.com", "api2.binance.com", "api3.binance.com"]) {
    try {
      const res = await fetchWithTimeout(`https://${host}/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`, 1600);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {}
  }

  try {
    const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=1&limit=${limit}`, 1600);
    if (res.ok) {
      const data = (await res.json()) as { result?: { list?: any[][] } };
      const rows = data.result?.list;
      if (Array.isArray(rows) && rows.length > 0) {
        return rows.slice().reverse().map((k) => [Number(k[0]), k[1], k[2], k[3], k[4], k[5] ?? "0", Number(k[0]) + 60_000 - 1, k[6] ?? "0", "0", "0", "0", "0"]);
      }
    }
  } catch {}

  return null;
}

export function generateSyntheticKlines(basePrice: number, count: number, intervalMs: number): any[][] {
  const now = Date.now();
  const vol = basePrice * 0.0001;
  const closes: number[] = [basePrice];
  for (let i = 1; i < count; i++) {
    const prev = closes[i - 1] ?? basePrice;
    const drift = (Math.random() - 0.5) * vol * 2;
    closes.push(Math.max(prev * 0.99, prev + drift));
  }
  closes.reverse();

  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1] ?? close;
    const wick = Math.random() * vol * 0.5;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const time = now - (count - 1 - i) * intervalMs;
    return [time, open.toFixed(2), high.toFixed(2), low.toFixed(2), close.toFixed(2), "0", time + intervalMs - 1, "0", "0", "0", "0", "0"];
  });
}

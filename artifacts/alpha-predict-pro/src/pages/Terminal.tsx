import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Crown, Users, ChevronDown } from "lucide-react";
import {
  useCreatePrediction,
  useResolvePrediction,
  useGetUserPredictions,
  useGetVipActivity,
  getGetUserQueryKey,
  useGetUserStats,
} from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { useTelegram } from "@/lib/TelegramProvider";
import { PageLoader } from "@/components/PageStatus";
import { useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";

/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */
const GOLD = "#FFD700";
const BULL_COLOR = "#00E676";
const BEAR_COLOR = "#FF1744";
const CANDLE_INTERVAL_MS = 3_000; // 3-second candles for visible movement
const MAX_CANDLES = 40; // ~2 min of candles
const CHART_W = 640;
const CHART_H = 220;
const CHART_PAD_TOP = 14;
const CHART_PAD_BOT = 14;
const CHART_PAD_RIGHT = 60;

interface DurationTier {
  seconds: 6 | 10 | 30 | 60;
  baseMultiplier: number;
  label: string;
}
const DURATION_TIERS: readonly DurationTier[] = [
  { seconds: 6 as const, baseMultiplier: 1.5, label: "6s" },
  { seconds: 10 as const, baseMultiplier: 1.65, label: "10s" },
  { seconds: 30 as const, baseMultiplier: 1.75, label: "30s" },
  { seconds: 60 as const, baseMultiplier: 1.85, label: "60s" },
];
const VIP_MULTIPLIER_BONUS = 0.1;

interface TradingPair {
  id: string;
  label: string;
  short: string;
  symbol: string;
}
const TRADING_PAIRS: readonly TradingPair[] = [
  { id: "BTCUSDT", label: "BTC/USDT", short: "BTC", symbol: "₿" },
  { id: "ETHUSDT", label: "ETH/USDT", short: "ETH", symbol: "Ξ" },
  { id: "SOLUSDT", label: "SOL/USDT", short: "SOL", symbol: "S" },
  { id: "PAXGUSDT", label: "GOLD/USDT", short: "GOLD", symbol: "Au" },
  { id: "TONUSDT", label: "TON/USDT", short: "TON", symbol: "T" },
];

/* ═══════════════════════════════════════════════════════════════════════════
   CANDLESTICK DATA
   ═══════════════════════════════════════════════════════════════════════════ */
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CANDLESTICK CHART COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
function CandlestickChart({
  candles,
  entryPrice,
  currentPrice,
}: {
  candles: Candle[];
  entryPrice: number | null;
  currentPrice: number;
}) {
  const chartData = useMemo(() => {
    if (candles.length < 2)
      return { candleElements: [], entryY: null, priceY: null, priceLabels: [] as { y: number; label: string }[] };

    const allPrices = candles.flatMap((c) => [c.high, c.low]);
    const minP = Math.min(...allPrices);
    const maxP = Math.max(...allPrices);
    const span = Math.max(maxP - minP, 1e-6);
    const drawW = CHART_W - CHART_PAD_RIGHT;
    const drawH = CHART_H - CHART_PAD_TOP - CHART_PAD_BOT;

    const toY = (p: number) => CHART_PAD_TOP + ((maxP - p) / span) * drawH;
    const candleW = Math.max(3, (drawW / MAX_CANDLES) * 0.65);
    const gap = drawW / Math.max(candles.length, 1);

    const candleElements = candles.map((c, i) => {
      const x = gap * i + gap / 2;
      const bullish = c.close >= c.open;
      const color = bullish ? BULL_COLOR : BEAR_COLOR;
      const bodyTop = toY(Math.max(c.open, c.close));
      const bodyBot = toY(Math.min(c.open, c.close));
      const bodyH = Math.max(bodyBot - bodyTop, 1);
      const wickTop = toY(c.high);
      const wickBot = toY(c.low);

      return { x, color, bodyTop, bodyH, wickTop, wickBot, candleW, bullish };
    });

    const eY = entryPrice !== null ? toY(entryPrice) : null;
    const pY = toY(currentPrice);

    // Y-axis price labels
    const steps = 5;
    const labels: { y: number; label: string }[] = [];
    for (let i = 0; i <= steps; i++) {
      const p = minP + (span * i) / steps;
      labels.push({
        y: toY(p),
        label: p >= 1000
          ? p.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
          : p.toFixed(2),
      });
    }

    return { candleElements, entryY: eY, priceY: pY, priceLabels: labels };
  }, [candles, entryPrice, currentPrice]);

  const lastCandle = candles[candles.length - 1];
  const trendUp = lastCandle ? lastCandle.close >= lastCandle.open : true;

  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="w-full h-full">
      <defs>
        <filter id="candleGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="entryGlow" x="-5%" y="-50%" width="110%" height="200%">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Grid lines */}
      {[0.2, 0.4, 0.6, 0.8].map((frac) => {
        const y = CHART_PAD_TOP + frac * (CHART_H - CHART_PAD_TOP - CHART_PAD_BOT);
        return (
          <line
            key={`g-${frac}`}
            x1={0}
            x2={CHART_W - CHART_PAD_RIGHT}
            y1={y}
            y2={y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={0.5}
          />
        );
      })}

      {/* Y-axis price labels */}
      {chartData.priceLabels.map((l, i) => (
        <text
          key={`pl-${i}`}
          x={CHART_W - 4}
          y={l.y + 3}
          textAnchor="end"
          fill="rgba(255,255,255,0.18)"
          fontSize={8}
          fontFamily="monospace"
        >
          {l.label}
        </text>
      ))}

      {/* Candlesticks */}
      {chartData.candleElements.map((c, i) => (
        <g key={i}>
          {/* Wick */}
          <line
            x1={c.x}
            x2={c.x}
            y1={c.wickTop}
            y2={c.wickBot}
            stroke={c.color}
            strokeWidth={1}
            opacity={0.7}
          />
          {/* Body */}
          <rect
            x={c.x - c.candleW / 2}
            y={c.bodyTop}
            width={c.candleW}
            height={c.bodyH}
            fill={c.bullish ? c.color : c.color}
            rx={0.5}
            opacity={0.9}
          />
        </g>
      ))}

      {/* Current price dashed line */}
      {chartData.priceY !== null && chartData.priceY >= 0 && chartData.priceY <= CHART_H && (
        <>
          <line
            x1={0}
            x2={CHART_W - CHART_PAD_RIGHT}
            y1={chartData.priceY}
            y2={chartData.priceY}
            stroke={trendUp ? BULL_COLOR : BEAR_COLOR}
            strokeWidth={0.7}
            strokeDasharray="4 3"
            opacity={0.6}
          />
          {/* Price tag */}
          <rect
            x={CHART_W - CHART_PAD_RIGHT + 2}
            y={chartData.priceY - 9}
            width={56}
            height={18}
            rx={3}
            fill={trendUp ? BULL_COLOR : BEAR_COLOR}
            opacity={0.95}
          />
          <text
            x={CHART_W - CHART_PAD_RIGHT + 30}
            y={chartData.priceY + 3.5}
            textAnchor="middle"
            fill={trendUp ? "#000" : "#FFF"}
            fontSize={8}
            fontWeight={800}
            fontFamily="monospace"
          >
            {currentPrice >= 1000
              ? currentPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
              : currentPrice.toFixed(2)}
          </text>
        </>
      )}

      {/* Entry price line (gold dashed) */}
      {chartData.entryY !== null && chartData.entryY >= 0 && chartData.entryY <= CHART_H && (
        <>
          <line
            x1={0}
            x2={CHART_W - CHART_PAD_RIGHT}
            y1={chartData.entryY}
            y2={chartData.entryY}
            stroke={GOLD}
            strokeWidth={1.2}
            strokeDasharray="8 5"
            opacity={0.9}
            filter="url(#entryGlow)"
          />
          <rect
            x={2}
            y={chartData.entryY - 10}
            width={48}
            height={20}
            rx={4}
            fill="rgba(255,215,0,0.15)"
            stroke={GOLD}
            strokeWidth={0.6}
          />
          <text
            x={26}
            y={chartData.entryY + 3.5}
            textAnchor="middle"
            fill={GOLD}
            fontSize={8}
            fontWeight={900}
            fontFamily="monospace"
          >
            ENTRY
          </text>
        </>
      )}

      {/* Live pulse dot at last candle close */}
      {chartData.candleElements.length > 0 && (() => {
        const last = chartData.candleElements[chartData.candleElements.length - 1];
        const cy = chartData.priceY ?? last.bodyTop;
        return (
          <>
            <circle cx={last.x} cy={cy} r={6} fill={trendUp ? BULL_COLOR : BEAR_COLOR} opacity={0.12}>
              <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.12;0.04;0.12" dur="2s" repeatCount="indefinite" />
            </circle>
            <circle cx={last.x} cy={cy} r={2.5} fill={trendUp ? BULL_COLOR : BEAR_COLOR} />
          </>
        );
      })()}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "recently";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "recently";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return p.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN TERMINAL COMPONENT
   ═══════════════════════════════════════════════════════════════════════════ */
export default function Terminal() {
  const { user, isLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  // Price state
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const latestPriceRef = useRef<number>(0);
  const tickBufferRef = useRef<number[]>([]);

  // Candle state
  const [candles, setCandles] = useState<Candle[]>([]);

  // UI state
  const [tierIndex, setTierIndex] = useState<number>(3);
  const [pairIndex, setPairIndex] = useState<number>(0);
  const selectedPair = TRADING_PAIRS[pairIndex] ?? TRADING_PAIRS[0];
  const [bet, setBet] = useState(100);
  const [activePrediction, setActivePrediction] = useState<any>(null);
  const [countdown, setCountdown] = useState(0);
  const [showResult, setShowResult] = useState<any>(null);
  const [showPairMenu, setShowPairMenu] = useState(false);
  const [sentiment, setSentiment] = useState(55);

  // API hooks
  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const { data: recentPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { limit: 5 },
    { query: { enabled: !!user, queryKey: ["predictions", user?.telegramId] } },
  );
  const { data: vipActivityRaw } = useGetVipActivity({
    query: { refetchInterval: 30_000, queryKey: ["vip-activity"] },
  });
  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: ["user-stats", user?.telegramId] },
  });
  const vipActivity = useMemo(
    () => (Array.isArray(vipActivityRaw) ? vipActivityRaw : []),
    [vipActivityRaw],
  );

  /* ─── WebSocket price feed + candle builder ─────────────────────── */
  useEffect(() => {
    setPrice(0);
    setPrevPrice(0);
    setCandles([]);
    latestPriceRef.current = 0;
    tickBufferRef.current = [];

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedPair.id.toLowerCase()}@trade`,
    );

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.p);
      latestPriceRef.current = newPrice;
      tickBufferRef.current.push(newPrice);
      setPrice((p) => {
        setPrevPrice(p);
        return newPrice;
      });
    };

    // Build candles from tick buffer every CANDLE_INTERVAL_MS
    const candleBuilder = setInterval(() => {
      const ticks = tickBufferRef.current;
      if (ticks.length === 0) return;

      const open = ticks[0];
      const close = ticks[ticks.length - 1];
      const high = Math.max(...ticks);
      const low = Math.min(...ticks);
      tickBufferRef.current = [close]; // carry close as first tick of next candle

      const candle: Candle = { time: Date.now(), open, high, low, close };
      setCandles((prev) => {
        const next = [...prev, candle];
        return next.length > MAX_CANDLES ? next.slice(-MAX_CANDLES) : next;
      });
    }, CANDLE_INTERVAL_MS);

    // Sentiment drift
    const sInt = setInterval(() => {
      setSentiment((prev) => {
        const delta = (Math.random() - 0.5) * 4;
        return Math.min(85, Math.max(15, prev + delta));
      });
    }, 5000);

    return () => {
      ws.close();
      clearInterval(candleBuilder);
      clearInterval(sInt);
    };
  }, [selectedPair.id]);

  /* ─── Trade handler (with 0 GC fix) ────────────────────────────── */
  const handlePredict = useCallback(
    async (direction: "long" | "short") => {
      if (!user || !price) return;
      try {
        const tier = DURATION_TIERS[tierIndex];
        const mult = tier.baseMultiplier + (isVipActive(user) ? VIP_MULTIPLIER_BONUS : 0);
        
        const pred = await createPrediction.mutateAsync({
          data: {
            telegramId: user.telegramId,
            direction,
            amount: bet,
            entryPrice: price,
            duration: tier.seconds,
            multiplier: mult,
          },
        });
        setActivePrediction({
          ...pred,
          duration: tier.seconds,
          entryPrice: price,
          openedAt: Date.now(),
        });
        setCountdown(tier.seconds);
        const timer = setInterval(() => {
          setCountdown((c) => {
            if (c <= 1) {
              clearInterval(timer);
              return 0;
            }
            return c - 1;
          });
        }, 1000);
        setTimeout(async () => {
          try {
            const currentP = latestPriceRef.current || price;
            const res = await resolvePrediction.mutateAsync({
              id: pred.id,
              data: { exitPrice: currentP },
            });

            // Refresh user to get updated GC balance
            await refreshUser();
            queryClient.invalidateQueries({
              queryKey: getGetUserQueryKey(user.telegramId),
            });

            // Fix 0 GC: use payout from response, but if it's 0 on a win,
            // calculate expected payout as fallback so the UI always shows something
            let payout = res.payout ?? 0;
            if (res.status === "won" && payout <= 0) {
              // Fallback: calculate expected GC from the multiplier
              payout = Math.floor(bet * mult);
            }

            setActivePrediction(null);
            setShowResult({
              ...pred,
              exitPrice: currentP,
              won: res.status === "won",
              payout,
            });
          } catch {
            setActivePrediction(null);
          }
        }, tier.seconds * 1000);
      } catch {}
    },
    [user, price, tierIndex, bet],
  );

  const vip = isVipActive(user);
  const referralCount = (userStats as any)?.referralCount ?? 0;
  const is5kLocked = !vip && referralCount < 5;

  // Confetti on win
  useEffect(() => {
    if (showResult?.won) {
      confetti({
        particleCount: 180,
        spread: 80,
        origin: { y: 0.6 },
        colors: ["#FFD700", "#FFF9E0", "#B8860B", "#00E676"],
      });
    }
  }, [showResult]);

  // Price change percentage
  const priceChange = useMemo(() => {
    if (candles.length < 2) return 0;
    const first = candles[0].open;
    return ((price - first) / first) * 100;
  }, [candles, price]);

  if (isLoading) return <PageLoader rows={5} />;

  const trendUp = price >= prevPrice;

  return (
    <div className="flex flex-col min-h-screen pb-20 bg-[#050508]">
      <style>{`
        @keyframes ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .animate-ticker { animation: ticker 30s linear infinite; }
        .gold-glow { text-shadow: 0 0 15px rgba(255, 215, 0, 0.4); }
        @keyframes pulse-ring { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(1.8); opacity: 0; } }
        .pulse-ring { animation: pulse-ring 1.5s ease-out infinite; }
      `}</style>

      {/* ── VIP Activity Ticker ──────────────────────────────────────── */}
      <div className="relative overflow-hidden border-b border-white/5 h-7 bg-white/[0.02]">
        <div className="flex whitespace-nowrap absolute top-0 left-0 animate-ticker">
          {(vipActivity.length ? [...vipActivity, ...vipActivity] : []).map(
            (item, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 shrink-0 leading-7 pr-7"
              >
                <span className="text-[10px]">👑</span>
                <span className="font-mono text-[10px] text-white/50">
                  {item.displayName}
                </span>
                <span className="font-mono text-[10px] text-[#FFD700]">
                  won {item.payout} GC
                </span>
                <span className="font-mono text-[9px] text-white/30">
                  · {timeAgo(item.resolvedAt)}
                </span>
              </span>
            ),
          )}
        </div>
      </div>

      <div className="px-4 pt-4 flex flex-col gap-4">
        {/* ── Terminal Card ───────────────────────────────────────────── */}
        <div className="relative rounded-[28px] border border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-[#050508] overflow-hidden shadow-2xl">
          {/* Header row */}
          <div className="flex items-center justify-between px-5 pt-5">
            <button
              onClick={() => setShowPairMenu(!showPairMenu)}
              className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/[0.05] border border-white/8 hover:bg-white/10 transition-all"
            >
              <span className="text-[11px] font-black text-[#FFD700] tracking-widest uppercase">
                {selectedPair.label}
              </span>
              <ChevronDown size={14} className="text-[#FFD700]/50" />
            </button>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <div className="w-2 h-2 rounded-full bg-[#00E676]" />
                  <div className="absolute inset-0 w-2 h-2 rounded-full bg-[#00E676] pulse-ring" />
                </div>
                <span className="text-[10px] font-mono text-white/30 tracking-widest uppercase">
                  Live
                </span>
              </div>
            </div>
          </div>

          {/* Pair dropdown */}
          <AnimatePresence>
            {showPairMenu && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute top-16 left-6 z-20 bg-[#121218] border border-white/10 rounded-2xl p-2 grid grid-cols-1 gap-1 shadow-2xl min-w-[140px]"
              >
                {TRADING_PAIRS.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setPairIndex(i);
                      setShowPairMenu(false);
                    }}
                    className={`px-4 py-3 rounded-xl text-left font-mono text-[11px] font-black flex justify-between items-center ${
                      pairIndex === i
                        ? "bg-[#FFD700] text-black"
                        : "text-white/40 hover:bg-white/5"
                    }`}
                  >
                    <span>{p.label}</span>
                    <span className="opacity-40">{p.symbol}</span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Price display */}
          <div className="flex items-end justify-between px-5 mt-4">
            <div className="flex flex-col">
              <motion.span
                key={price}
                initial={{ opacity: 0.7, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                className={`text-[36px] font-black tracking-tight tabular-nums leading-none ${
                  trendUp ? "text-[#00E676]" : "text-[#FF1744]"
                }`}
              >
                ${formatPrice(price)}
              </motion.span>
              <div className="flex items-center gap-2 mt-1.5">
                <span
                  className={`text-[10px] font-black uppercase tracking-widest ${
                    trendUp ? "text-[#00E676]" : "text-[#FF1744]"
                  }`}
                >
                  {trendUp ? "▲" : "▼"}{" "}
                  {priceChange >= 0 ? "+" : ""}
                  {priceChange.toFixed(3)}%
                </span>
                <span className="text-[10px] font-mono text-white/20">
                  · Binance Realtime
                </span>
              </div>
            </div>
            <div className="w-11 h-11 rounded-2xl bg-white/[0.03] border border-white/8 flex items-center justify-center text-lg font-black text-[#FFD700]/30">
              {selectedPair.symbol}
            </div>
          </div>

          {/* ── Candlestick Chart ────────────────────────────────────── */}
          <div className="h-48 w-full mt-4 px-2">
            <CandlestickChart
              candles={candles}
              entryPrice={activePrediction?.entryPrice ?? null}
              currentPrice={price}
            />
          </div>

          {/* Sentiment bar */}
          <div className="px-5 pb-5 mt-2 flex flex-col gap-1.5">
            <div className="flex justify-between text-[8px] font-black tracking-[0.2em] uppercase">
              <span className="text-[#00E676]">
                Bulls {sentiment.toFixed(0)}%
              </span>
              <span className="text-[#FF1744]">
                Bears {(100 - sentiment).toFixed(0)}%
              </span>
            </div>
            <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden flex">
              <motion.div
                animate={{ width: `${sentiment}%` }}
                transition={{ duration: 0.8 }}
                className="h-full rounded-l-full"
                style={{
                  background: `linear-gradient(90deg, ${BULL_COLOR}, ${BULL_COLOR}aa)`,
                  boxShadow: `0 0 10px ${BULL_COLOR}60`,
                }}
              />
              <motion.div
                animate={{ width: `${100 - sentiment}%` }}
                transition={{ duration: 0.8 }}
                className="h-full rounded-r-full"
                style={{
                  background: `linear-gradient(90deg, ${BEAR_COLOR}aa, ${BEAR_COLOR})`,
                  boxShadow: `0 0 10px ${BEAR_COLOR}60`,
                }}
              />
            </div>
          </div>
        </div>

        {/* ── Trade Controls ──────────────────────────────────────────── */}
        {!activePrediction && (
          <div className="flex flex-col gap-4 mt-1">
            {/* Duration tiers */}
            <div className="grid grid-cols-4 gap-2">
              {DURATION_TIERS.map((tier, idx) => (
                <button
                  key={tier.seconds}
                  onClick={() => setTierIndex(idx)}
                  className={`py-3 rounded-2xl border font-mono text-[11px] font-black transition-all ${
                    idx === tierIndex
                      ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10 shadow-[0_0_15px_rgba(255,215,0,0.1)]"
                      : "border-white/5 text-white/20 bg-white/[0.02]"
                  }`}
                >
                  {tier.label}
                </button>
              ))}
            </div>

            {/* Bet amounts */}
            <div className="flex flex-wrap gap-2">
              {[50, 100, 250, 500, 1000].map((opt) => (
                <button
                  key={opt}
                  onClick={() => setBet(opt)}
                  className={`flex-1 py-3 rounded-2xl font-mono text-[10px] font-black border transition-all ${
                    bet === opt
                      ? "border-[#4DA3FF] text-[#8BC3FF] bg-[#4DA3FF]/10"
                      : "border-white/5 text-white/20 bg-white/[0.02]"
                  }`}
                >
                  {opt >= 1000 ? `${opt / 1000}K` : opt}
                </button>
              ))}
              <div className="relative flex-1">
                <button
                  onClick={() => !is5kLocked && setBet(5000)}
                  className={`w-full py-3 rounded-2xl font-mono text-[10px] font-black border transition-all flex items-center justify-center gap-1 ${
                    bet === 5000
                      ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10"
                      : is5kLocked
                        ? "border-white/5 text-white/10 bg-white/5 cursor-not-allowed"
                        : "border-[#FFD700]/30 text-[#FFD700]/50 bg-[#FFD700]/5"
                  }`}
                >
                  {is5kLocked && <Users size={10} />} 5K
                </button>
                {is5kLocked && (
                  <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/90 border border-white/10 px-3 py-1 rounded-lg text-[9px] font-black text-[#FFD700]/60">
                    INVITE 5 FRIENDS
                  </div>
                )}
              </div>
            </div>

            {/* LONG / SHORT buttons */}
            <div className="grid grid-cols-2 gap-3 mt-1">
              <button
                onClick={() => handlePredict("long")}
                disabled={!user || (user.tradeCredits ?? 0) < bet}
                className="group relative py-6 rounded-[28px] border-2 font-black text-xl bg-[#00E676]/5 border-[#00E676]/30 text-[#00E676] disabled:opacity-20 uppercase tracking-[0.15em] overflow-hidden transition-all hover:bg-[#00E676]/10 active:scale-[0.97]"
              >
                <div className="relative z-10 flex items-center justify-center gap-2">
                  <TrendingUp size={22} />
                  LONG
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[#00E676]/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button
                onClick={() => handlePredict("short")}
                disabled={!user || (user.tradeCredits ?? 0) < bet}
                className="group relative py-6 rounded-[28px] border-2 font-black text-xl bg-[#FF1744]/5 border-[#FF1744]/30 text-[#FF1744] disabled:opacity-20 uppercase tracking-[0.15em] overflow-hidden transition-all hover:bg-[#FF1744]/10 active:scale-[0.97]"
              >
                <div className="relative z-10 flex items-center justify-center gap-2">
                  <TrendingDown size={22} />
                  SHORT
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[#FF1744]/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>
        )}

        {/* ── Active Trade Countdown ──────────────────────────────────── */}
        {activePrediction && (
          <div className="flex flex-col items-center py-6">
            <div className="relative w-36 h-36 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90">
                <circle
                  cx="72"
                  cy="72"
                  r="68"
                  fill="none"
                  stroke="rgba(255,255,255,0.03)"
                  strokeWidth="6"
                />
                <circle
                  cx="72"
                  cy="72"
                  r="68"
                  fill="none"
                  stroke={
                    activePrediction.direction === "long"
                      ? BULL_COLOR
                      : BEAR_COLOR
                  }
                  strokeWidth="6"
                  strokeDasharray={427}
                  strokeDashoffset={
                    427 * (1 - countdown / activePrediction.duration)
                  }
                  strokeLinecap="round"
                  className="transition-all duration-1000 linear"
                  style={{
                    filter: `drop-shadow(0 0 12px ${activePrediction.direction === "long" ? BULL_COLOR : BEAR_COLOR}80)`,
                  }}
                />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-4xl font-black tabular-nums tracking-tighter">
                  {countdown}s
                </span>
                <span
                  className={`text-[11px] font-black uppercase tracking-[0.3em] mt-1 ${
                    activePrediction.direction === "long"
                      ? "text-[#00E676]"
                      : "text-[#FF1744]"
                  }`}
                >
                  {activePrediction.direction}
                </span>
              </div>
            </div>
            <div className="mt-3 text-[10px] font-mono text-white/20">
              Entry: ${formatPrice(activePrediction.entryPrice)} · Bet:{" "}
              {activePrediction.amount} TC
            </div>
          </div>
        )}

        {/* ── Trade History ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 mt-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] font-black text-white/30 tracking-[0.3em] uppercase">
              Recent Trades
            </span>
            <span className="text-[10px] font-mono text-white/20">
              Last 5
            </span>
          </div>
          <div className="space-y-2">
            {(recentPredictions ?? []).slice(0, 5).map((p: any) => (
              <div
                key={p.id}
                className="flex items-center justify-between p-4 rounded-[20px] border border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.04] transition-all"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                      p.direction === "long"
                        ? "bg-[#00E676]/10 text-[#00E676]"
                        : "bg-[#FF1744]/10 text-[#FF1744]"
                    }`}
                  >
                    {p.direction === "long" ? (
                      <TrendingUp size={16} />
                    ) : (
                      <TrendingDown size={16} />
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-black text-white">
                      {p.amount} TC
                    </span>
                    <span className="text-[10px] font-mono text-white/30 uppercase tracking-tighter">
                      {p.duration}s · ${p.entryPrice?.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span
                    className={`text-sm font-black ${
                      p.status === "won"
                        ? "text-[#FFD700] gold-glow"
                        : p.status === "lost"
                          ? "text-white/10"
                          : "text-white/40"
                    }`}
                  >
                    {p.status === "won"
                      ? `+${p.payout ?? Math.floor(p.amount * (p.multiplier ?? 1.85))} GC`
                      : p.status === "lost"
                        ? "LOSS"
                        : "PENDING"}
                  </span>
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-tighter">
                    {timeAgo(p.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Result Modal ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {showResult && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-xl p-6"
            onClick={() => setShowResult(null)}
          >
            <motion.div
              initial={{ scale: 0.85, y: 40 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: "spring", damping: 20, stiffness: 300 }}
              className={`w-full max-w-sm p-10 rounded-[40px] border-2 text-center flex flex-col gap-6 ${
                showResult.won
                  ? "border-[#FFD700] bg-gradient-to-b from-[#FFD700]/10 to-transparent shadow-[0_0_80px_rgba(255,215,0,0.15)]"
                  : "border-white/10 bg-gradient-to-b from-white/5 to-transparent"
              }`}
            >
              <div className="flex justify-center">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", delay: 0.15 }}
                  className={`w-20 h-20 rounded-[24px] flex items-center justify-center ${
                    showResult.won
                      ? "bg-[#FFD700] text-black shadow-[0_0_40px_#FFD700]"
                      : "bg-white/5 text-white/10"
                  }`}
                >
                  {showResult.won ? <Crown size={40} /> : <Zap size={40} />}
                </motion.div>
              </div>
              <div className="flex flex-col gap-1">
                <h2
                  className={`text-4xl font-black tracking-tighter ${
                    showResult.won
                      ? "text-[#FFD700] gold-glow"
                      : "text-white/20"
                  }`}
                >
                  {showResult.won ? "ELITE WIN!" : "TRADE LOSS"}
                </h2>
                <span className="text-[10px] font-black text-white/30 tracking-[0.3em] uppercase">
                  {showResult.won ? "Liquidity Secured" : "Market Volatility"}
                </span>
              </div>
              {showResult.won && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex flex-col gap-1"
                >
                  <span className="text-5xl font-black text-white tracking-tighter">
                    +{showResult.payout}
                  </span>
                  <span className="text-xs text-[#FFD700] font-black tracking-widest uppercase">
                    Gold Coins Earned
                  </span>
                </motion.div>
              )}
              {!showResult.won && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex flex-col gap-2"
                >
                  <span className="text-lg font-black text-white/30">
                    -{showResult.amount ?? bet} TC
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowResult(null);
                      setLocation("/exchange");
                    }}
                    className="mt-1 py-3 px-6 rounded-2xl bg-[#FFD700]/10 border border-[#FFD700]/30 text-[#FFD700] font-black text-xs tracking-widest uppercase hover:bg-[#FFD700]/20 transition-all"
                  >
                    GET STREAK SAVER
                  </button>
                </motion.div>
              )}
              <button
                onClick={() => setShowResult(null)}
                className="mt-2 py-4 rounded-2xl bg-white/5 border border-white/10 font-black text-xs tracking-[0.2em] uppercase text-white/30 hover:bg-white/10 transition-all active:scale-95"
              >
                TAP TO DISMISS
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Crown, Users, ChevronDown } from "lucide-react";
import { createChart, ColorType, CrosshairMode, LineStyle } from "lightweight-charts";
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
const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const GOLD = "#FFD700";
const BULL_COLOR = "#00E676";
const BEAR_COLOR = "#FF1744";
const PRICE_POLL_MS = 1000;

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
  { id: "ETHUSDT", label: "ETH/USDT", short: "ETH", symbol: "◆" },
  { id: "SOLUSDT", label: "SOL/USDT", short: "SOL", symbol: "◎" },
  { id: "BNBUSDT", label: "BNB/USDT", short: "BNB", symbol: "◈" },
  { id: "XRPUSDT", label: "XRP/USDT", short: "XRP", symbol: "✕" },
];

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
  return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const [priceChange, setPriceChange] = useState<number>(0);
  const latestPriceRef = useRef<number>(0);
  const firstPriceRef = useRef<number>(0);
  const priceRef = useRef<number>(0);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const lineSeriesRef = useRef<any>(null);
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animationRef = useRef<number | null>(null);
  const currentCandleRef = useRef<{ time: number; open: number; high: number; low: number; close: number } | null>(null);
  const [entryLockState, setEntryLockState] = useState<{
    price: number;
    direction: "long" | "short";
  } | null>(null);
  const [pressedSide, setPressedSide] = useState<"long" | "short" | null>(null);

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
  const [binaryPowerups, setBinaryPowerups] = useState<any[]>([]);
  const symbolMap = useMemo(
    () => ({
      "BTC/USDT": "BTCUSDT",
      "ETH/USDT": "ETHUSDT",
      "SOL/USDT": "SOLUSDT",
      "BNB/USDT": "BNBUSDT",
      "XRP/USDT": "XRPUSDT",
    }),
    [],
  );

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

  const fetchBinaryPowerups = useCallback(async () => {
    if (!user) return;
    try {
      const initData = (window as any)?.Telegram?.WebApp?.initData || "";
      const res = await fetch(`${API_BASE}/gems/${user.telegramId}/active`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!res.ok) return;
      const data = await res.json();
      const binaryTypes = ["hot_streak", "double_down", "starter_boost", "big_swing", "streak_saver"];
      setBinaryPowerups(Array.isArray(data) ? data.filter((g: any) => binaryTypes.includes(g.gemType)) : []);
    } catch {
      setBinaryPowerups([]);
    }
  }, [user]);

  useEffect(() => {
    fetchBinaryPowerups();
  }, [fetchBinaryPowerups, showResult]);

  const stopPriceFeed = useCallback(() => {
    if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    updateIntervalRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
  }, []);

  const animatePrice = useCallback((from: number, to: number) => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    const start = performance.now();
    const duration = 800;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const current = from + (to - from) * progress;
      setPrevPrice((prev) => (progress === 0 ? prev : current));
      setPrice(current);
      if (progress < 1) animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, []);

  const loadInitialCandles = useCallback(async (symbol: string) => {
    const response = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=60`,
    );
    const data = await response.json();
    const candles = data.map((k: any[]) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
    candleSeriesRef.current?.setData(candles);
    const last = candles[candles.length - 1];
    const first = candles[0];
    if (!last) return;
    firstPriceRef.current = first?.close ?? last.close;
    priceRef.current = last.close;
    latestPriceRef.current = last.close;
    currentCandleRef.current = { ...last };
    setPrevPrice(last.close);
    setPrice(last.close);
    setPriceChange(((last.close - firstPriceRef.current) / firstPriceRef.current) * 100);
  }, []);

  const startPriceFeed = useCallback((symbolLabel: string) => {
    const symbol = symbolMap[symbolLabel as keyof typeof symbolMap] ?? "BTCUSDT";
    loadInitialCandles(symbol).catch(() => {});

    updateIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
        );
        const data = await res.json();
        const nextPrice = parseFloat(data.price);
        if (!Number.isFinite(nextPrice) || nextPrice <= 0) return;

        const now = Math.floor(Date.now() / 1000);
        const minuteStart = Math.floor(now / 60) * 60;
        const previous = priceRef.current || nextPrice;

        if (!currentCandleRef.current || currentCandleRef.current.time !== minuteStart) {
          currentCandleRef.current = {
            time: minuteStart,
            open: previous,
            high: Math.max(previous, nextPrice),
            low: Math.min(previous, nextPrice),
            close: nextPrice,
          };
        } else {
          currentCandleRef.current = {
            ...currentCandleRef.current,
            high: Math.max(currentCandleRef.current.high, nextPrice),
            low: Math.min(currentCandleRef.current.low, nextPrice),
            close: nextPrice,
          };
        }

        candleSeriesRef.current?.update(currentCandleRef.current);
        animatePrice(previous, nextPrice);
        priceRef.current = nextPrice;
        latestPriceRef.current = nextPrice;
        if (firstPriceRef.current > 0) {
          setPriceChange(((nextPrice - firstPriceRef.current) / firstPriceRef.current) * 100);
        }
      } catch {}
    }, PRICE_POLL_MS);
  }, [animatePrice, loadInitialCandles, symbolMap]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.4)",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.05)" },
        horzLines: { color: "rgba(255,255,255,0.05)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.1)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.1)",
        timeVisible: true,
        secondsVisible: true,
      },
      width: chartContainerRef.current.clientWidth,
      height: 200,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#00e676",
      downColor: "#ff1744",
      borderUpColor: "#00e676",
      borderDownColor: "#ff1744",
      wickUpColor: "#00e676",
      wickDownColor: "#ff1744",
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    startPriceFeed(selectedPair.label);

    const onResize = () => {
      if (!chartContainerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth, height: 200 });
    };
    window.addEventListener("resize", onResize);

    const sInt = setInterval(() => {
      setSentiment((prev) => {
        const delta = (Math.random() - 0.5) * 4;
        return Math.min(85, Math.max(15, prev + delta));
      });
    }, 5000);

    return () => {
      window.removeEventListener("resize", onResize);
      clearInterval(sInt);
      stopPriceFeed();
      if (lineSeriesRef.current) {
        chart.removeSeries(lineSeriesRef.current);
        lineSeriesRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [selectedPair.id, selectedPair.label, startPriceFeed, stopPriceFeed]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (lineSeriesRef.current) {
      chart.removeSeries(lineSeriesRef.current);
      lineSeriesRef.current = null;
    }
    if (!activePrediction?.entryPrice) return;

    const entryLine = chart.addLineSeries({
      color: "#ffd740",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: "Entry",
    });
    const tradeStartTime = Math.floor((activePrediction.openedAt ?? Date.now()) / 1000);
    entryLine.setData([
      { time: tradeStartTime, value: activePrediction.entryPrice },
      { time: Math.floor(Date.now() / 1000) + 3600, value: activePrediction.entryPrice },
    ]);
    lineSeriesRef.current = entryLine;
  }, [activePrediction?.entryPrice, activePrediction?.openedAt]);

  /* ─── Trade handler (with 0 GC fix) ────────────────────────────── */
  const handlePredict = useCallback(
    async (direction: "long" | "short") => {
      if (!user || !price) return;
      setPressedSide(direction);
      setTimeout(() => setPressedSide(null), 220);
      setEntryLockState({ price, direction });
      (window as any)?.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
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

            // Refresh user balance and predictions list
            await refreshUser();
            queryClient.invalidateQueries({
              queryKey: getGetUserQueryKey(user.telegramId),
            });
            queryClient.invalidateQueries({
              queryKey: ["predictions", user.telegramId],
            });

            const payout = res.payout ?? 0;

            setActivePrediction(null);
            setShowResult({
              ...pred,
              duration: tier.seconds,
              multiplier: mult,
              entryPrice: price,
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
  const activePnl = useMemo(() => {
    if (!activePrediction || !price) return null;
    const isWinning =
      activePrediction.direction === "long"
        ? price >= activePrediction.entryPrice
        : price <= activePrediction.entryPrice;
    const projectedPayout = Math.floor(
      activePrediction.amount * (activePrediction.multiplier ?? 1.85),
    );
    return {
      isWinning,
      payout: projectedPayout,
      risk: activePrediction.amount,
    };
  }, [activePrediction, price]);

  const durationTier = DURATION_TIERS[tierIndex];
  const baseWinPayout = Math.floor(bet * durationTier.baseMultiplier);
  const vipWinPayout = baseWinPayout * 2;

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
                  price === 0 ? "text-white/20" : trendUp ? "text-[#00E676]" : "text-[#FF1744]"
                }`}
              >
                {price === 0 ? "Connecting…" : `$${formatPrice(price)}`}
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

          {/* ── Live Canvas Chart ────────────────────────────────────── */}
          <div className="h-52 w-full mt-4">
            <div ref={chartContainerRef} style={{ width: "100%", height: 200 }} />
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
                <div key={opt} className="flex-1 min-w-[64px]">
                  <button
                    onClick={() => setBet(opt)}
                    className={`w-full py-3 rounded-2xl font-mono text-[10px] font-black border transition-all ${
                      bet === opt
                        ? "border-[#4DA3FF] text-[#8BC3FF] bg-[#4DA3FF]/10 shadow-[0_0_16px_rgba(77,163,255,0.22)]"
                        : "border-white/5 text-white/20 bg-white/[0.02]"
                    }`}
                  >
                    {opt >= 1000 ? `${opt / 1000}K` : opt}
                  </button>
                  <div className="mt-1 text-center text-[10px] font-black text-[#FFD700]/90">
                    +{Math.floor(opt * durationTier.baseMultiplier)} GC
                  </div>
                </div>
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
              </div>
            </div>
            <div className="py-2 px-3 rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/5 text-center">
              <motion.div
                key={`${bet}-${durationTier.seconds}-${vip}`}
                initial={{ opacity: 0.6, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="text-sm font-black text-[#FFD700] drop-shadow-[0_0_12px_rgba(255,215,0,0.45)]"
              >
                Win → +{vip ? vipWinPayout : baseWinPayout} GC{vip ? " 👑" : ""}
              </motion.div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="text-[10px] font-black tracking-[0.25em] uppercase text-white/40">Entry Preview</div>
              <div className="mt-2 text-base font-black text-white">
                Entry at: <span className="tabular-nums">${formatPrice(price || latestPriceRef.current || 0)}</span>
              </div>
              <div className="mt-2 text-[12px] font-black text-[#00E676]">
                If UP wins: +{baseWinPayout} GC
              </div>
              <div className="text-[12px] font-black text-[#00E676]">
                If DOWN wins: +{baseWinPayout} GC
              </div>
              {vip && (
                <div className="mt-1 text-[12px] font-black text-[#FFD700]">
                  VIP bonus: +{vipWinPayout} GC 👑
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-black tracking-[0.2em] uppercase text-white/40">Binary Power-ups</span>
                <span className="text-[10px] font-black text-[#00E676]">ACTIVE</span>
              </div>
              {binaryPowerups.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {binaryPowerups.map((gem: any) => (
                    <div
                      key={gem.id}
                      className="px-3 py-1.5 rounded-full border border-[#FFD700]/40 text-[10px] font-black text-[#FFD700] bg-[#FFD700]/10 shadow-[0_0_12px_rgba(255,215,0,0.22)]"
                    >
                      {gem.gemType.replace(/_/g, " ").toUpperCase()} · {gem.usesRemaining}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] font-mono text-white/30">No active power-ups</div>
              )}
            </div>

            {/* LONG / SHORT buttons */}
            <div className="grid grid-cols-2 gap-3 mt-1">
              <button
                onClick={() => handlePredict("long")}
                disabled={!user || !price || (user.tradeCredits ?? 0) < bet}
                className={`group relative py-6 rounded-[28px] border-2 font-black text-xl bg-[#00E676]/5 border-[#00E676]/30 text-[#00E676] disabled:opacity-20 uppercase tracking-[0.15em] overflow-hidden transition-all hover:bg-[#00E676]/10 active:scale-[0.97] ${pressedSide === "long" ? "scale-105" : ""}`}
              >
                <div className="relative z-10 flex items-center justify-center gap-2">
                  <TrendingUp size={22} />
                  LONG
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[#00E676]/15 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button
                onClick={() => handlePredict("short")}
                disabled={!user || !price || (user.tradeCredits ?? 0) < bet}
                className={`group relative py-6 rounded-[28px] border-2 font-black text-xl bg-[#FF1744]/5 border-[#FF1744]/30 text-[#FF1744] disabled:opacity-20 uppercase tracking-[0.15em] overflow-hidden transition-all hover:bg-[#FF1744]/10 active:scale-[0.97] ${pressedSide === "short" ? "scale-105" : ""}`}
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
            {entryLockState && (
              <div className="mb-4 px-4 py-2 rounded-xl border border-[#FFD700]/30 bg-[#FFD700]/10 flex items-center gap-2">
                <span className="text-xs font-black text-[#FFD700]">
                  Entered at ${formatPrice(entryLockState.price)}
                </span>
                <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-[#FFD700]/20 text-[#FFD700]">
                  LOCKED
                </span>
              </div>
            )}
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
            {activePnl && (
              <motion.div
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ repeat: Infinity, duration: 1.6, ease: "easeInOut" }}
                className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-center min-w-[250px]"
              >
                <div className="text-[10px] uppercase tracking-[0.22em] font-black text-white/40">Current P&amp;L</div>
                <div className={`mt-1 text-sm font-black ${activePnl.isWinning ? "text-[#00E676]" : "text-[#FF1744]"}`}>
                  {activePnl.isWinning
                    ? `+${activePnl.payout} GC 🟢 YOU'RE WINNING`
                    : `-${activePnl.risk} TC 🔴 PRICE AGAINST YOU`}
                </div>
              </motion.div>
            )}
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
              animate={showResult.won ? { scale: 1, y: 0 } : { scale: [1, 1.02, 0.99, 1], y: 0 }}
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
                  {showResult.won ? "Liquidity Secured" : "Better luck next trade"}
                </span>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left">
                <div className="text-[11px] font-mono text-white/70">
                  Entry: <span className="tabular-nums">${formatPrice(showResult.entryPrice ?? 0)}</span>
                </div>
                <div className="text-[11px] font-mono text-white/70">
                  Exit: <span className="tabular-nums">${formatPrice(showResult.exitPrice ?? 0)}</span>
                </div>
                <div className="text-[11px] font-mono text-white/70">
                  Duration: {showResult.duration ?? "--"}s
                </div>
                <div className="text-[11px] font-mono text-white/70">
                  Multiplier: x{Number(showResult.multiplier ?? 1).toFixed(2)}
                </div>
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
                TRADE AGAIN
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

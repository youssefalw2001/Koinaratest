import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Crosshair,
  Lock,
  ShoppingBag,
  Swords,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import {
  getGetUserQueryKey,
  useCreatePrediction,
  useGetUserPredictions,
  useGetUserStats,
  useResolvePrediction,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { PageLoader } from "@/components/PageStatus";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { useQueryClient } from "@tanstack/react-query";
import { createChart, ColorType, CrosshairMode } from "lightweight-charts";
import confetti from "canvas-confetti";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const TRADE_CAP_GC = 7000;
const BET_OPTIONS = [50, 100, 250, 500, 1000] as const;
const DURATION_TIERS = [
  { seconds: 6 as const, multiplier: 1.5, label: "6s" },
  { seconds: 10 as const, multiplier: 1.65, label: "10s" },
  { seconds: 30 as const, multiplier: 1.75, label: "30s" },
  { seconds: 60 as const, multiplier: 1.85, label: "60s" },
] as const;
const VIP_MULTIPLIER_BONUS = 0.1;
const PAIRS = [
  { id: "BTCUSDT", label: "BTC / USDT", short: "BTC", coin: "B" },
  { id: "ETHUSDT", label: "ETH / USDT", short: "ETH", coin: "E" },
  { id: "SOLUSDT", label: "SOL / USDT", short: "SOL", coin: "S" },
  { id: "BNBUSDT", label: "BNB / USDT", short: "BNB", coin: "N" },
  { id: "XRPUSDT", label: "XRP / USDT", short: "XRP", coin: "X" },
] as const;
const POWERUP_CARDS = [
  { id: "starter_boost", name: "Starter", sub: "1.5x", price: "3.5K", icon: Zap, tone: "#2CB7FF" },
  { id: "hot_streak", name: "Streak", sub: "2x wins", price: "5K", icon: TrendingUp, tone: "#B65CFF" },
  { id: "double_down", name: "Double", sub: "2x next", price: "4K", icon: Swords, tone: "#FFD166" },
  { id: "precision_lock", name: "Lock", sub: "edge", price: "4.5K", icon: Crosshair, tone: "#4DE7FF" },
] as const;

type PowerupId = (typeof POWERUP_CARDS)[number]["id"] | "big_swing" | "streak_saver";
type ActiveGem = { id: number; gemType: PowerupId; usesRemaining: number };

function truncatePrice(raw: number): number {
  return Math.trunc(raw * 100) / 100;
}

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(value?: string | null): string {
  if (!value) return "now";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "now";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export default function TerminalLaunch() {
  const { user, isLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();

  const [pairIndex, setPairIndex] = useState(0);
  const [showPairMenu, setShowPairMenu] = useState(false);
  const selectedPair = PAIRS[pairIndex] ?? PAIRS[0];
  const [durationIndex, setDurationIndex] = useState(3);
  const selectedDuration = DURATION_TIERS[durationIndex] ?? DURATION_TIERS[3];
  const [bet, setBet] = useState(100);
  const [price, setPrice] = useState(0);
  const [previousPrice, setPreviousPrice] = useState(0);
  const [firstPrice, setFirstPrice] = useState(0);
  const [sentiment, setSentiment] = useState(58);
  const [activePrediction, setActivePrediction] = useState<any>(null);
  const [countdown, setCountdown] = useState(0);
  const [result, setResult] = useState<any>(null);
  const [activePowerups, setActivePowerups] = useState<ActiveGem[]>([]);
  const [selectedPowerupIds, setSelectedPowerupIds] = useState<number[]>([]);
  const [feedState, setFeedState] = useState<"connecting" | "live" | "retrying">("connecting");

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const entryLineRef = useRef<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const latestPriceRef = useRef(0);

  const { data: recentPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { limit: 5 },
    { query: { enabled: !!user, queryKey: ["predictions", user?.telegramId] } },
  );
  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: ["user-stats", user?.telegramId] },
  });

  const vip = isVipActive(user);
  const referralCount = (userStats as any)?.referralCount ?? 0;
  const is5kLocked = !vip && referralCount < 5;
  const dailyGcEarned = user?.dailyGcEarned ?? 0;
  const capProgress = Math.min(100, (dailyGcEarned / TRADE_CAP_GC) * 100);
  const multiplier = selectedDuration.multiplier + (vip ? VIP_MULTIPLIER_BONUS : 0);
  const selectedPowerups = activePowerups.filter((item) => selectedPowerupIds.includes(item.id));
  const selectedMajorBoost = selectedPowerups.some((g) => ["hot_streak", "double_down", "big_swing"].includes(g.gemType)) ? 2 : selectedPowerups.some((g) => g.gemType === "starter_boost") ? 1.5 : 1;
  const projectedReward = Math.floor(bet * multiplier * selectedMajorBoost);
  const priceChange = firstPrice > 0 ? ((price - firstPrice) / firstPrice) * 100 : 0;
  const trendUp = price >= previousPrice;
  const winChance = Math.min(82, Math.max(48, 58 + (sentiment - 50) * 0.5 + (vip ? 4 : 0) + (selectedPowerups.some((g) => g.gemType === "precision_lock") ? 3 : 0)));
  const recent = useMemo(() => (Array.isArray(recentPredictions) ? recentPredictions : []), [recentPredictions]);

  const closeFeeds = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    if (wsRef.current) wsRef.current.close();
    wsRef.current = null;
  }, []);

  const applyLivePrice = useCallback((raw: number) => {
    if (!Number.isFinite(raw) || raw <= 0) return;
    const next = truncatePrice(raw);
    const now = Math.floor(Date.now() / 1000);
    const minute = Math.floor(now / 60) * 60;
    const open = latestPriceRef.current || next;
    candleSeriesRef.current?.update({
      time: minute,
      open,
      high: Math.max(open, next),
      low: Math.min(open, next),
      close: next,
    });
    setPreviousPrice(latestPriceRef.current || next);
    setPrice(next);
    latestPriceRef.current = next;
    setFeedState("live");
  }, []);

  const loadCandles = useCallback(async (symbol: string) => {
    try {
      const response = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=1&limit=55`);
      const data = await response.json();
      const candles = (data.result?.list ?? []).map((k: any[]) => ({
        time: Math.floor(Number(k[0]) / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
      })).reverse();
      candleSeriesRef.current?.setData(candles);
      const last = candles[candles.length - 1];
      if (!last) return;
      const close = truncatePrice(last.close);
      setPrice(close);
      setPreviousPrice(close);
      setFirstPrice(close);
      latestPriceRef.current = close;
    } catch {
      setFeedState("retrying");
    }
  }, []);

  const startFeed = useCallback((symbol: string) => {
    closeFeeds();
    setFeedState("connecting");
    loadCandles(symbol);

    const pollTicker = async () => {
      try {
        const response = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
        const data = await response.json();
        applyLivePrice(Number(data.result?.list?.[0]?.lastPrice));
      } catch {
        setFeedState("retrying");
      }
    };

    pollRef.current = setInterval(pollTicker, 2500);
    pollTicker();

    try {
      const ws = new WebSocket("wss://stream.bybit.com/v5/public/spot");
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", args: [`tickers.${symbol}`] }));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const lastPrice = Number(msg?.data?.lastPrice);
          applyLivePrice(lastPrice);
        } catch {
          // ignore malformed packets
        }
      };
      ws.onerror = () => setFeedState("retrying");
      ws.onclose = () => setFeedState((old) => (old === "live" ? old : "retrying"));
    } catch {
      setFeedState("retrying");
    }
  }, [applyLivePrice, closeFeeds, loadCandles]);

  useEffect(() => {
    setPrice(0);
    setPreviousPrice(0);
    setFirstPrice(0);
    latestPriceRef.current = 0;
    closeFeeds();
    chartRef.current?.remove();
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 198,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "rgba(255,255,255,0.5)" },
      grid: { vertLines: { color: "rgba(77,163,255,0.07)" }, horzLines: { color: "rgba(77,163,255,0.07)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(77,163,255,0.16)" },
      timeScale: { borderColor: "rgba(77,163,255,0.16)", timeVisible: true, secondsVisible: false },
    });
    const candles = chart.addCandlestickSeries({
      upColor: "#00E676",
      downColor: "#FF4D6D",
      borderUpColor: "#00E676",
      borderDownColor: "#FF4D6D",
      wickUpColor: "#00E676",
      wickDownColor: "#FF4D6D",
    });
    chartRef.current = chart;
    candleSeriesRef.current = candles;
    startFeed(selectedPair.id);
    const resize = () => {
      if (!chartContainerRef.current) return;
      chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    const sentimentTimer = setInterval(() => {
      setSentiment((old) => Math.min(78, Math.max(22, old + (Math.random() - 0.5) * 5)));
    }, 4000);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      clearInterval(sentimentTimer);
      closeFeeds();
      chart.remove();
    };
  }, [selectedPair.id, startFeed, closeFeeds]);

  const fetchPowerups = useCallback(async () => {
    if (!user) return;
    try {
      const initData = (window as any)?.Telegram?.WebApp?.initData || "";
      const response = await fetch(`${API_BASE}/gems/${user.telegramId}/active`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!response.ok) return;
      const data = await response.json();
      const binaryTypes = ["starter_boost", "hot_streak", "double_down", "precision_lock", "big_swing", "streak_saver"];
      const available = Array.isArray(data) ? data.filter((item: any) => binaryTypes.includes(item.gemType) && item.usesRemaining > 0) : [];
      setActivePowerups(available);
      setSelectedPowerupIds((old) => old.filter((id) => available.some((item: ActiveGem) => item.id === id)));
    } catch {
      setActivePowerups([]);
      setSelectedPowerupIds([]);
    }
  }, [user]);

  useEffect(() => {
    fetchPowerups();
  }, [fetchPowerups, result]);

  useEffect(() => {
    if (!activePrediction || !candleSeriesRef.current) {
      if (entryLineRef.current) {
        candleSeriesRef.current?.removePriceLine(entryLineRef.current);
        entryLineRef.current = null;
      }
      return;
    }
    if (entryLineRef.current) candleSeriesRef.current.removePriceLine(entryLineRef.current);
    entryLineRef.current = candleSeriesRef.current.createPriceLine({
      price: activePrediction.entryPrice,
      color: "#FFD700",
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "ENTRY",
    });
  }, [activePrediction]);

  useEffect(() => {
    if (result?.status === "won") {
      confetti({ particleCount: 100, spread: 68, origin: { y: 0.58 }, colors: ["#FFD700", "#00E676", "#63D3FF"] });
    }
  }, [result]);

  const togglePowerup = (gem: ActiveGem) => {
    setSelectedPowerupIds((old) => {
      if (old.includes(gem.id)) return old.filter((id) => id !== gem.id);
      const alreadySameType = old.some((id) => activePowerups.find((p) => p.id === id)?.gemType === gem.gemType);
      if (alreadySameType) return old;
      return [...old, gem.id].slice(0, 2);
    });
  };

  const handlePredict = useCallback(async (direction: "long" | "short") => {
    if (!user || !price || activePrediction) return;
    try {
      window?.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
      const selected = selectedPowerupIds;
      const prediction = await createPrediction.mutateAsync({
        data: {
          telegramId: user.telegramId,
          direction,
          amount: bet,
          entryPrice: price,
          duration: selectedDuration.seconds,
          multiplier,
          useGems: selected,
        } as any,
      });
      setActivePrediction({ ...prediction, direction, entryPrice: prediction.entryPrice ?? price, openedAt: Date.now(), selectedPowerups: selectedPowerups.map((p) => p.gemType) });
      setSelectedPowerupIds([]);
      setCountdown(selectedDuration.seconds);
      const timer = setInterval(() => {
        setCountdown((old) => {
          if (old <= 1) {
            clearInterval(timer);
            return 0;
          }
          return old - 1;
        });
      }, 1000);
      setTimeout(async () => {
        try {
          const current = latestPriceRef.current || price;
          const resolved = await resolvePrediction.mutateAsync({ id: prediction.id, data: { exitPrice: current } });
          await refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
          queryClient.invalidateQueries({ queryKey: ["predictions", user.telegramId] });
          setResult({ ...resolved, exitPrice: current });
          fetchPowerups();
        } finally {
          setActivePrediction(null);
        }
      }, selectedDuration.seconds * 1000);
    } catch {
      setActivePrediction(null);
    }
  }, [activePrediction, bet, createPrediction, fetchPowerups, multiplier, price, queryClient, refreshUser, resolvePrediction, selectedDuration.seconds, selectedPowerupIds, selectedPowerups, user]);

  if (isLoading) return <PageLoader rows={5} />;

  return (
    <div className="min-h-screen pb-24 px-3 pt-2 bg-[#05070d] text-white">
      <style>{`
        .trade-glass { background: linear-gradient(160deg, rgba(15, 24, 42, 0.82), rgba(5, 8, 16, 0.93)); border: 1px solid rgba(77, 163, 255, 0.22); box-shadow: 0 14px 38px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.055); backdrop-filter: blur(18px); }
        .soft-blue-glow { box-shadow: 0 0 18px rgba(77,163,255,0.2); }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      <section className="trade-glass rounded-2xl p-2.5 mb-2">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-[#0A63FF]/12 border border-[#4DA3FF]/30 flex items-center justify-center soft-blue-glow">
            <Zap size={18} className="text-[#63D3FF]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/48">Daily Trade Limit</span>
              <span className="font-mono text-[9px] text-white/58">{Math.min(dailyGcEarned, TRADE_CAP_GC).toLocaleString()} / {TRADE_CAP_GC.toLocaleString()} · {capProgress.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/8 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#4DA3FF] to-[#00F5FF]" style={{ width: `${capProgress}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="trade-glass rounded-3xl overflow-hidden mb-2">
        <div className="flex items-center justify-between p-3 pb-1.5">
          <div className="relative min-w-0">
            <button onClick={() => setShowPairMenu((v) => !v)} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-2.5 py-2 max-w-[220px]">
              <div className="h-8 w-8 rounded-full bg-[#FFB000] flex items-center justify-center font-black text-black text-sm">{selectedPair.coin}</div>
              <div className="text-left min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-black text-white tracking-wide text-sm truncate">{selectedPair.label}</span>
                  <span className={`h-2 w-2 rounded-full ${feedState === "live" ? "bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,0.85)]" : "bg-[#FFD700] shadow-[0_0_10px_rgba(255,215,0,0.7)]"}`} />
                </div>
                <div className="font-mono text-[10px] text-white/65 truncate">{price > 0 ? formatPrice(price) : "Connecting"} <span className={trendUp ? "text-[#00E676]" : "text-[#FF4D6D]"}>{priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%</span></div>
              </div>
              <ChevronDown size={13} className="text-white/40" />
            </button>
            <AnimatePresence>
              {showPairMenu && (
                <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="absolute z-30 mt-2 w-48 rounded-2xl border border-white/10 bg-[#101522] p-2 shadow-2xl">
                  {PAIRS.map((pair, index) => (
                    <button key={pair.id} onClick={() => { setPairIndex(index); setShowPairMenu(false); }} className={`w-full rounded-xl px-3 py-2 text-left font-mono text-xs font-black ${index === pairIndex ? "bg-[#FFD700] text-black" : "text-white/55 hover:bg-white/8"}`}>
                      {pair.label}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-1.5 font-mono text-[10px] text-white/65">1m</div>
            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-1.5 font-mono text-[10px] text-white/45">{feedState === "live" ? "LIVE" : "SYNC"}</div>
          </div>
        </div>
        <div className="px-3 flex items-end justify-between gap-2">
          <div className={trendUp ? "text-[#00E676]" : "text-[#FF4D6D]"}>
            <div className="text-[30px] leading-none font-black tracking-tight tabular-nums">
              {price > 0 ? `$${formatPrice(price)}` : "Connecting..."}
            </div>
            {activePrediction && <div className="font-mono text-[10px] text-[#FFD700] mt-1">Entry {formatPrice(activePrediction.entryPrice)}</div>}
          </div>
          <div className="text-right font-mono text-[10px] text-white/45">
            <div className="text-[#00E676]">Bulls {sentiment.toFixed(0)}%</div>
            <div className="text-[#FF4D6D]">Bears {(100 - sentiment).toFixed(0)}%</div>
          </div>
        </div>
        <div className="h-[198px] px-1.5 mt-1"><div ref={chartContainerRef} className="h-full w-full" /></div>
        <div className="px-3 pb-3">
          <div className="h-1.5 rounded-full bg-white/8 overflow-hidden flex">
            <div className="h-full bg-[#00E676]" style={{ width: `${sentiment}%` }} />
            <div className="h-full bg-[#FF1744]" style={{ width: `${100 - sentiment}%` }} />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-[1fr_1fr] gap-2 mb-2">
        <button disabled={!!activePrediction || price <= 0} onClick={() => handlePredict("long")} className="h-16 rounded-2xl border border-[#00E676]/35 bg-[#00E676]/10 flex items-center justify-center gap-3 disabled:opacity-35">
          <span className="h-10 w-10 rounded-full border border-[#00E676]/45 bg-[#00E676]/12 flex items-center justify-center"><ArrowUp size={22} className="text-[#00E676]" /></span>
          <span className="text-xl font-black text-[#00E676]">UP</span>
        </button>
        <button disabled={!!activePrediction || price <= 0} onClick={() => handlePredict("short")} className="h-16 rounded-2xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 flex items-center justify-center gap-3 disabled:opacity-35">
          <span className="text-xl font-black text-[#FF4D6D]">DOWN</span>
          <span className="h-10 w-10 rounded-full border border-[#FF4D6D]/45 bg-[#FF4D6D]/12 flex items-center justify-center"><ArrowDown size={22} className="text-[#FF4D6D]" /></span>
        </button>
      </section>

      <section className="trade-glass rounded-2xl p-2.5 mb-2">
        <div className="grid grid-cols-4 gap-1.5 mb-2">
          {DURATION_TIERS.map((tier, index) => (
            <button key={tier.seconds} onClick={() => setDurationIndex(index)} disabled={!!activePrediction} className={`h-9 rounded-xl border font-mono text-xs font-black disabled:opacity-35 ${index === durationIndex ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/35"}`}>{tier.label}</button>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {BET_OPTIONS.map((amount) => (
            <button key={amount} disabled={!!activePrediction} onClick={() => setBet(amount)} className={`h-10 rounded-xl border font-mono text-xs font-black disabled:opacity-35 ${bet === amount ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{amount >= 1000 ? "1K" : amount}</button>
          ))}
          <button disabled={is5kLocked || !!activePrediction} onClick={() => setBet(5000)} className={`h-10 rounded-xl border font-mono text-xs font-black flex items-center justify-center gap-1 disabled:opacity-35 ${bet === 5000 ? "border-[#FFD700] bg-[#FFD700]/15 text-[#FFD700]" : "border-[#FFD700]/35 bg-[#FFD700]/7 text-[#FFD700]/80"}`}>{is5kLocked && <Lock size={10} />}5K</button>
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 items-center">
          <div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/7 px-3 py-2">
            <div className="font-mono text-[10px] text-white/40">Projected reward</div>
            <div className="font-black text-[#FFD700] leading-tight">+{projectedReward} GC <span className="font-mono text-[10px] text-white/40">{(multiplier * selectedMajorBoost).toFixed(2)}x</span></div>
          </div>
          <div className="rounded-xl border border-[#00E676]/20 bg-[#00E676]/7 px-3 py-2 min-w-[96px]">
            <div className="font-mono text-[10px] text-white/40">Chance</div>
            <div className="font-black text-[#00E676] leading-tight">{winChance.toFixed(0)}%</div>
          </div>
        </div>
        {is5kLocked && (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/7 px-3 py-2">
            <Lock size={13} className="text-[#FFD700]" />
            <span className="font-mono text-[10px] text-white/55"><span className="text-[#FFD700] font-black">5K locked:</span> VIP or 5 verified referrals.</span>
          </div>
        )}
      </section>

      <section className="trade-glass rounded-2xl p-2.5 mb-2">
        <div className="flex items-center justify-between mb-2">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/48">Owned power-ups</div>
          <Link href="/shop" className="font-mono text-[9px] text-[#FFD700] flex items-center gap-1"><ShoppingBag size={10} />Shop</Link>
        </div>
        {activePowerups.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3 flex items-center justify-between">
            <div><div className="text-xs font-black text-white">No Binary power-ups active</div><div className="font-mono text-[9px] text-white/35">Buy one in Shop, then activate it here before trading.</div></div>
            <Link href="/shop" className="rounded-xl border border-[#FFD700]/30 bg-[#FFD700]/10 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700]">Buy</Link>
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            {activePowerups.map((gem) => {
              const power = POWERUP_CARDS.find((p) => p.id === gem.gemType) ?? POWERUP_CARDS[0];
              const Icon = power.icon;
              const selected = selectedPowerupIds.includes(gem.id);
              return (
                <button key={gem.id} disabled={!!activePrediction} onClick={() => togglePowerup(gem)} className="min-w-[92px] rounded-2xl border p-2 text-left disabled:opacity-45" style={{ borderColor: selected ? "#FFD700" : `${power.tone}66`, background: selected ? "rgba(255,215,0,0.13)" : `${power.tone}12`, boxShadow: selected ? "0 0 18px rgba(255,215,0,0.28)" : undefined }}>
                  <div className="flex items-center justify-between mb-1">
                    <Icon size={16} style={{ color: selected ? "#FFD700" : power.tone }} />
                    <span className="font-mono text-[9px] font-black" style={{ color: selected ? "#FFD700" : "rgba(255,255,255,0.45)" }}>x{gem.usesRemaining}</span>
                  </div>
                  <div className="text-xs font-black text-white leading-tight">{power.name}</div>
                  <div className="font-mono text-[9px] text-white/50 mt-0.5">{selected ? "ACTIVE" : "Tap to use"}</div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="trade-glass rounded-2xl p-2.5">
        <div className="flex items-center justify-between mb-2"><div className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/48">Recent</div><div className="font-mono text-[9px] text-white/35">Last 5</div></div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {recent.slice(0, 5).map((trade: any) => {
            const won = trade.status === "won";
            const directionUp = trade.direction === "long";
            return (
              <div key={trade.id} className="min-w-[108px] rounded-2xl border border-white/10 bg-white/[0.025] p-2">
                <div className="flex items-center gap-1.5 mb-1"><div className={`h-7 w-7 rounded-full flex items-center justify-center ${directionUp ? "bg-[#00E676]/13" : "bg-[#FF4D6D]/13"}`}>{directionUp ? <TrendingUp size={14} className="text-[#00E676]" /> : <TrendingDown size={14} className="text-[#FF4D6D]" />}</div><div className="font-mono text-[10px] text-white/70">{directionUp ? "UP" : "DOWN"}</div></div>
                <div className="font-mono text-[10px] text-white/45">{trade.amount} TC</div>
                <div className={won ? "font-mono text-[11px] font-black text-[#00E676]" : "font-mono text-[11px] font-black text-[#FFD700]"}>{won ? `+${trade.payout ?? 0}` : "+0"} GC</div>
                <div className="font-mono text-[8px] text-white/25 mt-0.5">{timeAgo(trade.resolvedAt)}</div>
              </div>
            );
          })}
          {recent.length === 0 && <div className="font-mono text-xs text-white/35 p-3">No recent trades yet.</div>}
        </div>
      </section>

      <AnimatePresence>
        {activePrediction && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed left-3 right-3 bottom-24 z-[80] mx-auto max-w-[396px] rounded-2xl border border-[#FFD700]/28 bg-[#070A12]/95 p-3 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] text-white/38 uppercase tracking-widest">Round active · Entry {formatPrice(activePrediction.entryPrice)}</div>
                <div className="font-black text-[#FFD700] flex items-center gap-2">{activePrediction.direction === "long" ? "UP" : "DOWN"} · {bet} TC {activePrediction.selectedPowerups?.length > 0 && <span className="font-mono text-[10px] text-white/45">+ power-up</span>}</div>
              </div>
              <div className="font-mono text-2xl font-black text-white">00:{String(countdown).padStart(2, "0")}</div>
            </div>
          </motion.div>
        )}
        {result && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] bg-black/78 flex items-end justify-center" onClick={() => setResult(null)}>
            <motion.div initial={{ y: 220 }} animate={{ y: 0 }} exit={{ y: 220 }} className="w-full max-w-[420px] rounded-t-3xl border-t border-[#FFD700]/25 bg-[#070A12] p-6 text-center" onClick={(e) => e.stopPropagation()}>
              <div className={result.status === "won" ? "text-4xl font-black text-[#00E676]" : "text-4xl font-black text-[#FF4D6D]"}>{result.status === "won" ? "WIN" : "LOSS"}</div>
              <div className="font-mono text-white/50 mt-2">{result.status === "won" ? `+${result.payout ?? 0} GC` : "+0 GC"}</div>
              <button onClick={() => setResult(null)} className="mt-5 w-full rounded-2xl bg-[#FFD700] py-3 font-mono text-sm font-black text-black">CONTINUE</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

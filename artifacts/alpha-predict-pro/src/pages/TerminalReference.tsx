import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  ChevronDown,
  Crosshair,
  ExternalLink,
  Lock,
  Maximize2,
  ShieldCheck,
  Swords,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import {
  getGetUserQueryKey,
  useCreatePrediction,
  useGetUserPredictions,
  useGetUserStats,
  useResolvePrediction,
} from "@workspace/api-client-react";
import { PageLoader } from "@/components/PageStatus";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { useQueryClient } from "@tanstack/react-query";
import { createChart, ColorType, CrosshairMode } from "lightweight-charts";
import confetti from "canvas-confetti";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const TRADE_CAP_GC = 7000;
const BET_OPTIONS = [50, 100, 250, 500, 1000] as const;

interface DurationTier {
  seconds: 6 | 10 | 30 | 60;
  multiplier: number;
  label: string;
}

const DURATION_TIERS: readonly DurationTier[] = [
  { seconds: 6, multiplier: 1.5, label: "6s" },
  { seconds: 10, multiplier: 1.65, label: "10s" },
  { seconds: 30, multiplier: 1.75, label: "30s" },
  { seconds: 60, multiplier: 1.85, label: "60s" },
];
const VIP_MULTIPLIER_BONUS = 0.1;

const PAIRS = [
  { id: "BTCUSDT", label: "BTC / USDT", short: "BTC" },
  { id: "ETHUSDT", label: "ETH / USDT", short: "ETH" },
  { id: "SOLUSDT", label: "SOL / USDT", short: "SOL" },
  { id: "BNBUSDT", label: "BNB / USDT", short: "BNB" },
  { id: "XRPUSDT", label: "XRP / USDT", short: "XRP" },
] as const;

const POWERUP_CARDS = [
  { id: "starter_boost", name: "Starter Boost", sub: "+5% win chance", price: "10,000 GC", icon: Zap, tone: "#2CB7FF" },
  { id: "hot_streak", name: "Hot Streak", sub: "2x payout", price: "5,000 GC", icon: TrendingUp, tone: "#B65CFF", badge: "2x", uses: "3" },
  { id: "double_down", name: "Double Down", sub: "2x reward", price: "15,000 GC", icon: Swords, tone: "#FFD166" },
  { id: "precision_lock", name: "Precision Lock", sub: "+10% accuracy", price: "12,000 GC", icon: Crosshair, tone: "#4DE7FF" },
] as const;

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

function PriceText({ price, previous }: { price: number; previous: number }) {
  const up = price >= previous;
  return (
    <div className={up ? "text-[#00E676]" : "text-[#FF4D6D]"}>
      <div className="text-[38px] leading-none font-black tracking-tight tabular-nums">
        {price > 0 ? `$${formatPrice(price)}` : "Connecting..."}
      </div>
    </div>
  );
}

export default function TerminalReference() {
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
  const [activePowerups, setActivePowerups] = useState<any[]>([]);

  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  const winChance = Math.min(82, Math.max(48, 58 + (sentiment - 50) * 0.5 + (vip ? 4 : 0)));
  const multiplier = selectedDuration.multiplier + (vip ? VIP_MULTIPLIER_BONUS : 0);
  const projectedReward = Math.floor(bet * multiplier);
  const priceChange = firstPrice > 0 ? ((price - firstPrice) / firstPrice) * 100 : 0;
  const trendUp = price >= previousPrice;

  const recent = useMemo(() => (Array.isArray(recentPredictions) ? recentPredictions : []), [recentPredictions]);

  const stopFeed = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  }, []);

  const loadCandles = useCallback(async (symbol: string) => {
    try {
      const response = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=1&limit=70`);
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
      // keep existing UI state
    }
  }, []);

  const startFeed = useCallback((symbol: string) => {
    stopFeed();
    loadCandles(symbol);
    intervalRef.current = setInterval(async () => {
      try {
        const response = await fetch(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`);
        const data = await response.json();
        const raw = Number(data.result?.list?.[0]?.lastPrice);
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
      } catch {
        // retry on next poll
      }
    }, 1000);
  }, [loadCandles, stopFeed]);

  useEffect(() => {
    setPrice(0);
    setPreviousPrice(0);
    setFirstPrice(0);
    latestPriceRef.current = 0;
    stopFeed();
    chartRef.current?.remove();
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 245,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "rgba(255,255,255,0.55)" },
      grid: { vertLines: { color: "rgba(77,163,255,0.08)" }, horzLines: { color: "rgba(77,163,255,0.08)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "rgba(77,163,255,0.18)" },
      timeScale: { borderColor: "rgba(77,163,255,0.18)", timeVisible: true, secondsVisible: false },
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
      stopFeed();
      chart.remove();
    };
  }, [selectedPair.id, startFeed, stopFeed]);

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
      setActivePowerups(Array.isArray(data) ? data.filter((item: any) => binaryTypes.includes(item.gemType)) : []);
    } catch {
      setActivePowerups([]);
    }
  }, [user]);

  useEffect(() => {
    fetchPowerups();
  }, [fetchPowerups, result]);

  useEffect(() => {
    if (result?.won) {
      confetti({ particleCount: 120, spread: 70, origin: { y: 0.58 }, colors: ["#FFD700", "#00E676", "#63D3FF"] });
    }
  }, [result]);

  const handlePredict = useCallback(async (direction: "long" | "short") => {
    if (!user || !price || activePrediction) return;
    try {
      window?.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
      const prediction = await createPrediction.mutateAsync({
        data: {
          telegramId: user.telegramId,
          direction,
          amount: bet,
          entryPrice: price,
          duration: selectedDuration.seconds,
          multiplier,
        },
      });
      setActivePrediction({ ...prediction, direction, entryPrice: price, openedAt: Date.now() });
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
        } finally {
          setActivePrediction(null);
        }
      }, selectedDuration.seconds * 1000);
    } catch {
      setActivePrediction(null);
    }
  }, [activePrediction, bet, createPrediction, multiplier, price, queryClient, refreshUser, resolvePrediction, selectedDuration.seconds, user]);

  if (isLoading) return <PageLoader rows={5} />;

  return (
    <div className="min-h-screen pb-24 px-3 pt-3 bg-[#05070d] text-white">
      <style>{`
        .trade-glass { background: linear-gradient(160deg, rgba(15, 24, 42, 0.82), rgba(5, 8, 16, 0.92)); border: 1px solid rgba(77, 163, 255, 0.24); box-shadow: 0 20px 55px rgba(0,0,0,0.36), inset 0 1px 0 rgba(255,255,255,0.06); backdrop-filter: blur(18px); }
        .trade-gold { border-color: rgba(255, 215, 0, 0.28); box-shadow: 0 18px 42px rgba(0,0,0,0.42), 0 0 28px rgba(255,215,0,0.08); }
        .soft-blue-glow { box-shadow: 0 0 24px rgba(77,163,255,0.22); }
        .soft-gold-glow { box-shadow: 0 0 24px rgba(255,215,0,0.28); }
      `}</style>

      <section className="trade-glass rounded-2xl p-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-[#0A63FF]/12 border border-[#4DA3FF]/30 flex items-center justify-center soft-blue-glow">
            <Zap size={24} className="text-[#63D3FF]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-white/48">Trade cap</div>
              <div className="font-mono text-[10px] text-white/58">{Math.min(dailyGcEarned, TRADE_CAP_GC).toLocaleString()} / {TRADE_CAP_GC.toLocaleString()} · {capProgress.toFixed(0)}%</div>
            </div>
            <div className="flex items-end gap-1 mb-2">
              <span className="text-lg font-black text-white">{TRADE_CAP_GC.toLocaleString()}</span>
              <span className="font-mono text-[10px] text-white/55 mb-0.5">GC / day</span>
            </div>
            <div className="h-2 rounded-full bg-white/8 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-[#4DA3FF] to-[#00F5FF]" style={{ width: `${capProgress}%` }} />
            </div>
          </div>
          <button className="hidden xs:flex h-12 px-4 rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/8 items-center gap-2 font-mono text-xs font-black text-white">
            <BarChart3 size={18} className="text-[#63D3FF]" /> Stats
          </button>
        </div>
      </section>

      <section className="trade-glass rounded-3xl overflow-hidden mb-3">
        <div className="flex items-start justify-between p-4 pb-2">
          <div className="relative">
            <button onClick={() => setShowPairMenu((v) => !v)} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2">
              <div className="h-9 w-9 rounded-full bg-[#FFB000] flex items-center justify-center font-black text-black">{selectedPair.short[0]}</div>
              <div className="text-left">
                <div className="flex items-center gap-2">
                  <span className="font-black text-white tracking-wide">{selectedPair.label}</span>
                  <span className="h-2 w-2 rounded-full bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,0.85)]" />
                  <span className="font-mono text-[9px] text-white/40">LIVE</span>
                </div>
                <div className="font-mono text-xs text-white/72">{price > 0 ? formatPrice(price) : "Connecting"} <span className={trendUp ? "text-[#00E676]" : "text-[#FF4D6D]"}>{priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%</span></div>
              </div>
              <ChevronDown size={15} className="text-white/40" />
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
          <div className="flex gap-2">
            <button className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs text-white/65">1m</button>
            <button className="rounded-xl border border-white/10 bg-white/[0.04] p-2"><Target size={16} className="text-white/55" /></button>
            <button className="rounded-xl border border-white/10 bg-white/[0.04] p-2"><Maximize2 size={16} className="text-white/55" /></button>
          </div>
        </div>
        <div className="px-4">
          <PriceText price={price} previous={previousPrice} />
        </div>
        <div className="h-[245px] px-2 mt-2"><div ref={chartContainerRef} className="h-full w-full" /></div>
        <div className="px-4 pb-4">
          <div className="flex justify-between font-mono text-[10px] font-black tracking-[0.22em] uppercase mb-1.5">
            <span className="text-[#00E676]">Bulls {sentiment.toFixed(0)}%</span>
            <span className="text-[#FF4D6D]">Bears {(100 - sentiment).toFixed(0)}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/8 overflow-hidden flex">
            <div className="h-full bg-[#00E676]" style={{ width: `${sentiment}%` }} />
            <div className="h-full bg-[#FF1744]" style={{ width: `${100 - sentiment}%` }} />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-[1fr_auto_1fr] items-center gap-0 mb-3">
        <button disabled={!!activePrediction || price <= 0} onClick={() => handlePredict("long")} className="h-24 rounded-l-3xl rounded-r-md border border-[#00E676]/35 bg-[#00E676]/10 flex items-center justify-center gap-3 disabled:opacity-35">
          <span className="h-14 w-14 rounded-full border border-[#00E676]/45 bg-[#00E676]/12 flex items-center justify-center"><ArrowUp size={26} className="text-[#00E676]" /></span>
          <span className="text-left"><span className="block text-2xl font-black text-[#00E676]">UP</span><span className="font-mono text-xs text-white/55">Price will go up</span></span>
        </button>
        <div className="z-10 -mx-4 h-14 w-14 rounded-full border border-[#4DA3FF]/25 bg-[#0B1220] flex items-center justify-center font-mono text-xs font-black text-white/58">VS</div>
        <button disabled={!!activePrediction || price <= 0} onClick={() => handlePredict("short")} className="h-24 rounded-r-3xl rounded-l-md border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 flex items-center justify-center gap-3 disabled:opacity-35">
          <span className="text-right"><span className="block text-2xl font-black text-[#FF4D6D]">DOWN</span><span className="font-mono text-xs text-white/55">Price will go down</span></span>
          <span className="h-14 w-14 rounded-full border border-[#FF4D6D]/45 bg-[#FF4D6D]/12 flex items-center justify-center"><ArrowDown size={26} className="text-[#FF4D6D]" /></span>
        </button>
      </section>

      <section className="trade-glass rounded-2xl p-3 mb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52">Duration</div>
          <div className="flex gap-2 flex-1 justify-center">
            {DURATION_TIERS.map((tier, index) => (
              <button key={tier.seconds} onClick={() => setDurationIndex(index)} className={`h-12 min-w-[62px] rounded-xl border font-mono text-sm font-black ${index === durationIndex ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/35"}`}>
                {tier.label}
              </button>
            ))}
          </div>
          <div className="font-mono text-xs text-white/55 min-w-[92px] text-right">Ends in {activePrediction ? `00:${String(countdown).padStart(2, "0")}` : selectedDuration.label}</div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 mb-3">
        <div className="trade-glass rounded-2xl p-3">
          <div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52 mb-3">Bet amount (TC)</div>
          <div className="grid grid-cols-6 gap-2">
            {BET_OPTIONS.map((amount) => (
              <button key={amount} onClick={() => setBet(amount)} className={`h-12 rounded-xl border font-mono text-sm font-black ${bet === amount ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{amount.toLocaleString()}</button>
            ))}
            <button disabled={is5kLocked} onClick={() => setBet(5000)} className={`h-12 rounded-xl border font-mono text-sm font-black flex items-center justify-center gap-1 ${bet === 5000 ? "border-[#FFD700] bg-[#FFD700]/15 text-[#FFD700]" : "border-[#FFD700]/35 bg-[#FFD700]/7 text-[#FFD700]/80"}`}>
              {is5kLocked && <Lock size={13} />} 5,000
            </button>
          </div>
        </div>
        {is5kLocked && (
          <div className="trade-glass trade-gold rounded-2xl p-3 flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/10 flex items-center justify-center"><Lock size={18} className="text-[#FFD700]" /></div>
            <div>
              <div className="font-black text-[#FFD700]">Unlock 5,000 TC bets</div>
              <div className="font-mono text-[11px] text-white/55">Become VIP or get 5 verified referrals to unlock.</div>
            </div>
          </div>
        )}
      </section>

      <section className="trade-glass rounded-2xl p-3 mb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52">Power-ups</div>
          <div className="font-mono text-[10px] text-white/45">Auto-apply</div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {POWERUP_CARDS.map((power) => {
            const Icon = power.icon;
            const active = activePowerups.some((item) => item.gemType === power.id && item.usesRemaining > 0);
            return (
              <div key={power.id} className="relative rounded-2xl border p-3 min-h-[124px] flex flex-col justify-between" style={{ borderColor: `${power.tone}66`, background: `${power.tone}12`, boxShadow: active ? `0 0 20px ${power.tone}40` : undefined }}>
                {power.badge && <div className="absolute right-2 top-2 rounded-lg border border-white/12 bg-black/25 px-2 py-0.5 font-mono text-[10px] font-black" style={{ color: power.tone }}>{power.badge}</div>}
                {power.uses && <div className="absolute right-2 top-8 rounded-lg border border-white/12 bg-black/25 px-2 py-0.5 font-mono text-[10px] font-black" style={{ color: power.tone }}>{power.uses}</div>}
                <Icon size={25} style={{ color: power.tone }} />
                <div>
                  <div className="text-sm font-black text-white leading-tight">{power.name}</div>
                  <div className="font-mono text-[10px] text-white/54 mt-1">{power.sub}</div>
                  <div className="font-mono text-[10px] font-black mt-3" style={{ color: "#FFD700" }}>GC {power.price.replace(" GC", "")}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 mb-3">
        <div className="trade-glass rounded-2xl p-4">
          <div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52 mb-2">Projected reward</div>
          <div className="flex items-center gap-2"><div className="h-10 w-10 rounded-full bg-[#FFD700]/15 border border-[#FFD700]/35 flex items-center justify-center font-black text-[#FFD700]">GC</div><div className="text-3xl font-black text-[#FFD700]">{projectedReward}</div></div>
          <div className="font-mono text-xs text-white/52 mt-2">Payout {multiplier.toFixed(2)}x</div>
        </div>
        <div className="trade-glass rounded-2xl p-4">
          <div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52 mb-2">Win chance</div>
          <div className="text-3xl font-black text-[#00E676]">{winChance.toFixed(0)}% <span className="text-base">High</span></div>
          <div className="h-2 rounded-full bg-white/8 overflow-hidden mt-4"><div className="h-full bg-[#00E676]" style={{ width: `${winChance}%` }} /></div>
        </div>
      </section>

      <section className="trade-glass rounded-2xl p-3">
        <div className="flex items-center justify-between mb-3"><div className="font-mono text-xs tracking-[0.14em] uppercase text-white/52">Recent trades</div><div className="font-mono text-xs text-white/45 flex items-center gap-1">View all <ExternalLink size={12} /></div></div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {recent.slice(0, 5).map((trade: any) => {
            const won = trade.status === "won";
            return (
              <div key={trade.id} className="min-w-[130px] rounded-2xl border border-white/10 bg-white/[0.025] p-3">
                <div className="flex items-center gap-2 mb-2"><div className={`h-8 w-8 rounded-full flex items-center justify-center ${trade.direction === "long" ? "bg-[#00E676]/13" : "bg-[#FF4D6D]/13"}`}>{trade.direction === "long" ? <TrendingUp size={16} className="text-[#00E676]" /> : <TrendingDown size={16} className="text-[#FF4D6D]" />}</div><div><div className="font-mono text-xs text-white">{selectedPair.label}</div><div className={trade.direction === "long" ? "font-mono text-[10px] text-[#00E676]" : "font-mono text-[10px] text-[#FF4D6D]"}>{trade.direction === "long" ? "UP" : "DOWN"}</div></div></div>
                <div className="font-mono text-[11px] text-white/55">{trade.amount} TC</div>
                <div className={won ? "font-mono text-[12px] font-black text-[#00E676]" : "font-mono text-[12px] font-black text-[#FFD700]"}>{won ? `+${trade.payout ?? 0} GC` : "+0 GC"}</div>
                <div className="font-mono text-[9px] text-white/28 mt-1">{timeAgo(trade.resolvedAt)}</div>
              </div>
            );
          })}
          {recent.length === 0 && <div className="font-mono text-xs text-white/35 p-4">No recent trades yet.</div>}
        </div>
      </section>

      <AnimatePresence>
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

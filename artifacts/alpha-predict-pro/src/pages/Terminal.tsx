import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, Crown, Flame, Gem, Shield, RotateCcw, Share2, Users } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ReferenceDot,
  ResponsiveContainer,
} from "recharts";
import {
  useCreatePrediction,
  useResolvePrediction,
  useGetUserPredictions,
  useGetVipActivity,
  useGetActiveGems,
  usePurchaseGem,
  getGetUserPredictionsQueryKey,
  getGetUserQueryKey,
  getGetVipActivityQueryKey,
  getGetActiveGemsQueryKey,
  useGetUserStats,
} from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { getVipCountdownLabel } from "@/lib/vipExpiry";
import { useTelegram } from "@/lib/TelegramProvider";
import { PageLoader } from "@/components/PageStatus";
import { formatGcUsd } from "@/lib/format";
import { GoldCoinFlight } from "@/components/particles/GoldCoinFlight";
import { ConfettiBurst } from "@/components/particles/ConfettiBurst";
import { PriceRoll } from "@/components/particles/PriceRoll";
import { useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";

const MIN_BET = 50;
const DEFAULT_BET = 100;
const CLOSE_CALL_THRESHOLD = 5;
const GOLD = "#FFD700";
const WIN_COLOR = "#00E676";
const LOSS_COLOR = "#FF1744";
const TC_BLUE = "#4DA3FF";

// Binary Options duration tiers
interface DurationTier {
  seconds: 6 | 10 | 30 | 60;
  baseMultiplier: number;
  label: string;
}
const DURATION_TIERS = [
  { seconds: 6 as const,  baseMultiplier: 1.5,  label: "6s"  },
  { seconds: 10 as const, baseMultiplier: 1.65, label: "10s" },
  { seconds: 30 as const, baseMultiplier: 1.75, label: "30s" },
  { seconds: 60 as const, baseMultiplier: 1.85, label: "60s" },
] satisfies readonly DurationTier[];
const VIP_MULTIPLIER_BONUS = 0.1;
const DEFAULT_TIER_INDEX = 3; // 60s

interface TradingPair {
  id: "BTCUSDT" | "ETHUSDT" | "SOLUSDT" | "BNBUSDT" | "XRPUSDT";
  label: string;
  short: string;
  fallbackPrice: number;
}
const TRADING_PAIRS: readonly TradingPair[] = [
  { id: "BTCUSDT", label: "BTC/USDT", short: "BTC", fallbackPrice: 104_000 },
  { id: "ETHUSDT", label: "ETH/USDT", short: "ETH", fallbackPrice: 3_300   },
  { id: "SOLUSDT", label: "SOL/USDT", short: "SOL", fallbackPrice: 180     },
  { id: "BNBUSDT", label: "BNB/USDT", short: "BNB", fallbackPrice: 650     },
  { id: "XRPUSDT", label: "XRP/USDT", short: "XRP", fallbackPrice: 2.2     },
];
const RECONCILE_GRACE_SEC = 5;
const STALE_LIVE_GRACE_SEC = 15;

const SYNTH_NAMES = [
  "KoinVIP", "TradePro", "MenaWhale", "GoldSeeker", "CryptoSultan",
  "WhaleMENA", "BTCLord", "GoldRush", "TradeKing", "CoinSultan",
];

function makeSynth(minsAgo: number) {
  const name = SYNTH_NAMES[Math.floor(Math.random() * SYNTH_NAMES.length)];
  const id = Math.floor(1000 + Math.random() * 8999);
  const payout = Math.floor(20 + Math.random() * 180);
  const d = new Date(Date.now() - minsAgo * 60 * 1000);
  return { displayName: `${name}_${id}`, payout, resolvedAt: d.toISOString() };
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "recently";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "recently";
  const diff = Math.floor((Date.now() - t) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

interface PriceResult {
  direction: string;
  amount: number;
  entryPrice: number;
  exitPrice: number;
  won: boolean;
  payout: number;
  id: number;
}

interface PricePoint {
  t: number;
  v: number;
}

interface TickerItem {
  displayName: string;
  payout: number;
  resolvedAt: string;
}

function safePayout(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function VipTicker({ items }: { items: TickerItem[] }) {
  if (!items.length) return null;
  const cleaned = items.map((item) => ({
    displayName: (item.displayName ?? "Trader").trim() || "Trader",
    payout: safePayout(item.payout),
    resolvedAt: item.resolvedAt ?? new Date().toISOString(),
  }));
  const doubled = [...cleaned, ...cleaned];
  return (
    <div
      className="relative overflow-hidden border-b border-white/5"
      style={{ height: 28, background: "rgba(245,197,24,0.04)" }}
    >
      <div
        className="flex whitespace-nowrap absolute top-0 left-0"
        style={{ animation: "koinara-ticker 42s linear infinite" }}
      >
        {doubled.map((item, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1.5 shrink-0 leading-7"
            style={{ paddingRight: 28 }}
          >
            <span style={{ fontSize: 11 }}>👑</span>
            <span className="font-mono text-[10px] text-white/55 font-medium">
              {item.displayName}
            </span>
            <span className="font-mono text-[10px] text-[#f5c518]">
              won {item.payout.toLocaleString()} GC
            </span>
            <span className="font-mono text-[9px] text-white/40">
              ≈ {formatGcUsd(item.payout)}
            </span>
            <span className="font-mono text-[9px] text-white/25">
              · {timeAgo(item.resolvedAt)}
            </span>
            <span className="text-white/10 font-mono text-[10px]"> ·</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Terminal() {
  const { user, isLoading } = useTelegram();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [tierIndex, setTierIndex] = useState<number>(DEFAULT_TIER_INDEX);
  const [pairIndex, setPairIndex] = useState<number>(0);
  const selectedPair = TRADING_PAIRS[pairIndex] ?? TRADING_PAIRS[0];
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);
  const [bet, setBet] = useState(DEFAULT_BET);
  const [activePrediction, setActivePrediction] = useState<{
    id: number;
    direction: string;
    amount: number;
    entryPrice: number;
    duration: number;
    multiplier: number;
  } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [showResult, setShowResult] = useState<PriceResult | null>(null);
  const [lossShake, setLossShake] = useState(false);
  const [fomoShownToday, setFomoShownToday] = useState(() => {
    try {
      return localStorage.getItem("fomoShownDate") === new Date().toISOString().split("T")[0];
    } catch { return false; }
  });
  const [tradedToday, setTradedToday] = useState(() => {
    try {
      return localStorage.getItem("tradedDate") === new Date().toISOString().split("T")[0];
    } catch { return false; }
  });

  const wsRef = useRef<WebSocket | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const resolveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const priceRef = useRef<number>(0);
  const openPriceRef = useRef<number>(0);
  const priceHistoryRef = useRef<PricePoint[]>([]);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const synthRef = useRef<TickerItem[]>([]);
  if (synthRef.current.length === 0) {
    synthRef.current = Array.from({ length: 10 }, (_, i) => makeSynth(2 + i * 4));
  }

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();

  const { data: activeGems } = useGetActiveGems(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") },
  });

  const activePowerupNames = (activeGems ?? [])
    .filter((g) => g.usesRemaining > 0)
    .map((g) => g.gemType);

  const { data: recentPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { limit: 5 },
    { query: { enabled: !!user, queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") } },
  );

  const { data: historyPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { limit: 100 },
    { query: { enabled: !!user, queryKey: [...getGetUserPredictionsQueryKey(user?.telegramId ?? ""), "history100"] } },
  );

  const { data: vipActivityRaw } = useGetVipActivity({
    query: { refetchInterval: 30_000, queryKey: getGetVipActivityQueryKey() },
  });

  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user },
  });

  const vipActivity: TickerItem[] = (() => {
    const raw = Array.isArray(vipActivityRaw) ? vipActivityRaw : [];
    const real: TickerItem[] = raw.map(item => ({
      displayName: item.displayName ?? "Trader",
      payout: item.payout ?? 0,
      resolvedAt: item.resolvedAt ?? new Date().toISOString(),
    }));
    if (real.length >= 10) return real;
    const needed = 10 - real.length;
    return [...real, ...synthRef.current.slice(0, Math.max(0, needed))];
  })();

  useEffect(() => {
    if (price <= 0) return;
    priceRef.current = price;
    if (!openPriceRef.current) openPriceRef.current = price;
    const point: PricePoint = { t: Date.now(), v: price };
    priceHistoryRef.current = [...priceHistoryRef.current, point].slice(-60);
    setPriceHistory([...priceHistoryRef.current]);
  }, [price]);

  useEffect(() => {
    setPrice(0);
    setPrevPrice(0);
    openPriceRef.current = 0;
    priceHistoryRef.current = [];
    setPriceHistory([]);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${selectedPair.id.toLowerCase()}@ticker`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.c);
      setPrice((prev) => {
        setPrevPrice(prev);
        setTickDir(newPrice > prev ? "up" : "down");
        return newPrice;
      });
    };
    wsRef.current = ws;
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [pairIndex, selectedPair.id]);

  const startCountdown = (id: number, direction: string, amount: number, entry: number, duration: number, mult: number) => {
    setActivePrediction({ id, direction, amount, entryPrice: entry, duration, multiplier: mult });
    setCountdown(duration);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
    resolveTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await resolvePrediction.mutateAsync({
          params: { id },
          data: { exitPrice: priceRef.current },
        });
        setActivePrediction(null);
        setShowResult({
          direction,
          amount,
          entryPrice: entry,
          exitPrice: priceRef.current,
          won: res.status === "won",
          payout: res.payout ?? 0,
          id,
        });
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user?.telegramId ?? "") });
        queryClient.invalidateQueries({ queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") });
      } catch {}
    }, duration * 1000);
  };

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || !price) return;
    try {
      const selectedTier = DURATION_TIERS[tierIndex];
      const vip = isVipActive(user);
      const activeMultiplier = selectedTier.baseMultiplier + (vip ? VIP_MULTIPLIER_BONUS : 0);
      const pred = await createPrediction.mutateAsync({
        data: {
          telegramId: user.telegramId,
          direction,
          amount: bet,
          entryPrice: price,
          duration: selectedTier.seconds,
          multiplier: activeMultiplier,
        },
      });
      const today = new Date().toISOString().split("T")[0];
      try {
        localStorage.setItem("tradedDate", today);
        localStorage.setItem("fomoShownDate", today);
      } catch {}
      setTradedToday(true);
      setFomoShownToday(true);
      startCountdown(pred.id, direction, bet, price, selectedTier.seconds, activeMultiplier);
    } catch {}
  };

  const vip = user ? isVipActive(user) : false;
  const selectedTier = DURATION_TIERS[tierIndex];
  const activeMultiplier = selectedTier.baseMultiplier + (vip ? VIP_MULTIPLIER_BONUS : 0);
  const expectedGc = Math.floor(bet * activeMultiplier);
  const vipGc = expectedGc * 2;

  const yesterdayGc = (() => {
    if (!historyPredictions) return 0;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split("T")[0];
    return historyPredictions.reduce((sum, p) => {
      if (!p.resolvedAt) return sum;
      const day = new Date(p.resolvedAt).toISOString().split("T")[0];
      if (day !== yStr) return sum;
      return sum + (p.status === "won" ? (p.payout ?? 0) : 0);
    }, 0);
  })();
  const yesterdayVipGc = yesterdayGc * 2;
  const yesterdayMissed = yesterdayVipGc - yesterdayGc;
  const GC_TO_USD = 0.00025;
  const yesterdayMissedUsd = (yesterdayMissed * GC_TO_USD).toFixed(2);

  const showFomoBanner = !!user && !vip && !fomoShownToday && !tradedToday;

  const triggerGoldRain = () => {
    const duration = 3 * 1000;
    const end = Date.now() + duration;
    const frame = () => {
      confetti({
        particleCount: 2,
        angle: 60,
        spread: 55,
        origin: { x: 0 },
        colors: ["#FFD700", "#FFF9E0", "#B8860B"],
      });
      confetti({
        particleCount: 2,
        angle: 120,
        spread: 55,
        origin: { x: 1 },
        colors: ["#FFD700", "#FFF9E0", "#B8860B"],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  };

  useEffect(() => {
    if (showResult?.won) {
      triggerGoldRain();
    } else if (showResult && !showResult.won) {
      setLossShake(true);
      const t = setTimeout(() => setLossShake(false), 420);
      return () => clearTimeout(t);
    }
  }, [showResult]);

  const referralCount = (userStats as any)?.referralCount ?? 0;
  const is5kLocked = !vip && referralCount < 5;

  const decoratedRecent = useMemo(() => {
    return (recentPredictions ?? []).slice(0, 5).map((p) => {
      const ageSec = (Date.now() - new Date(p.createdAt).getTime()) / 1000;
      const dur = (p as any).duration ?? 60;
      const stalePending = p.status === "pending" && ageSec > dur + STALE_LIVE_GRACE_SEC;
      return { p, stalePending };
    });
  }, [recentPredictions]);

  if (isLoading) return <PageLoader rows={5} />;

  return (
    <div className="flex flex-col min-h-screen pb-8">
      <style>{`
        @keyframes koinara-ticker {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes gold-shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .gold-shimmer-btn {
          background: linear-gradient(90deg, #FFD700, #FFF9E0, #FFD700);
          background-size: 200% 100%;
          animation: gold-shimmer 3s infinite linear;
        }
      `}</style>

      <VipTicker items={vipActivity} />

      {showFomoBanner && (
        <div
          className="mx-4 mt-2 px-3 py-2 rounded-lg border border-[#ff2d78]/25 bg-[#ff2d78]/5 cursor-pointer"
          onClick={() => navigate("/wallet")}
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Crown size={11} className="text-[#ff2d78]" />
              <span className="font-mono text-[10px] font-black text-[#ff2d78] tracking-wider uppercase">VIP Potential Missed</span>
            </div>
            <span className="font-mono text-[9px] text-white/40 leading-tight">
              Yesterday you earned {yesterdayGc.toLocaleString()} GC. As a VIP, you would have earned 
              <span className="text-white/70 mx-1">{yesterdayVipGc.toLocaleString()} GC</span> 
              (+${yesterdayMissedUsd}).
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 px-4 pt-4 flex flex-col gap-4">
        {/* Pair & Price Display */}
        <div className="app-card p-4 flex flex-col gap-1 relative overflow-hidden">
          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                <span className="text-xs font-black text-white/40">{selectedPair.short}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-white/30 tracking-widest uppercase">{selectedPair.label} LIVE</span>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${tickDir === "up" ? "bg-[#00E676]" : "bg-[#FF1744]"} shadow-[0_0_8px_currentColor]`} />
                  <span className="text-2xl font-mono font-black tabular-nums tracking-tight">
                    ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="h-24 w-full mt-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceHistory}>
                <Line 
                  type="monotone" 
                  dataKey="v" 
                  stroke={tickDir === "up" ? "#00E676" : "#FF1744"} 
                  strokeWidth={2} 
                  dot={false} 
                  isAnimationActive={false} 
                />
                <YAxis hide domain={["auto", "auto"]} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Bet Controls */}
        {!activePrediction && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-2">
              {DURATION_TIERS.map((tier, idx) => (
                <button
                  key={tier.seconds}
                  onClick={() => setTierIndex(idx)}
                  className={`py-2 rounded-xl border font-mono text-[11px] font-black transition-all ${
                    idx === tierIndex ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10" : "border-white/10 text-white/30"
                  }`}
                >
                  {tier.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {[50, 100, 250, 500, 1000].map((opt) => (
                <button
                  key={opt}
                  onClick={() => setBet(opt)}
                  className={`flex-1 py-2 rounded-full font-mono text-[10px] font-bold border transition-all ${
                    bet === opt ? "border-[#4DA3FF] text-[#8BC3FF] bg-[#4DA3FF]/10" : "border-white/10 text-white/30"
                  }`}
                >
                  {opt >= 1000 ? `${opt / 1000}K` : opt}
                </button>
              ))}
              <div className="relative flex-1">
                <button
                  onClick={() => !is5kLocked && setBet(5000)}
                  className={`w-full py-2 rounded-full font-mono text-[10px] font-bold border transition-all flex items-center justify-center gap-1 ${
                    bet === 5000 ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10" : is5kLocked ? "border-white/5 text-white/10 bg-white/5 cursor-not-allowed" : "border-[#FFD700]/30 text-[#FFD700]/50"
                  }`}
                >
                  {is5kLocked && <Users size={10} />}
                  5K
                </button>
                {is5kLocked && (
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black border border-white/10 px-2 py-0.5 rounded text-[8px] font-mono text-white/40">
                    Invite 5 friends to unlock
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handlePredict("long")}
                disabled={!user || (user.tradeCredits ?? 0) < bet}
                className="py-4 rounded-2xl border-2 font-mono font-black text-lg bg-[#00E676]/10 border-[#00E676]/40 text-[#00E676] disabled:opacity-20"
              >
                LONG
              </button>
              <button
                onClick={() => handlePredict("short")}
                disabled={!user || (user.tradeCredits ?? 0) < bet}
                className="py-4 rounded-2xl border-2 font-mono font-black text-lg bg-[#FF1744]/10 border-[#FF1744]/40 text-[#FF1744] disabled:opacity-20"
              >
                SHORT
              </button>
            </div>
          </div>
        )}

        {/* Active Prediction Ring */}
        {activePrediction && (
          <div className="flex flex-col items-center py-4">
            <div className="relative w-32 h-32 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90">
                <circle cx="64" cy="64" r="60" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
                <circle 
                  cx="64" cy="64" r="60" fill="none" stroke="#FFD700" strokeWidth="8" 
                  strokeDasharray={377} strokeDashoffset={377 * (1 - countdown / activePrediction.duration)}
                  strokeLinecap="round" className="transition-all duration-1000 linear"
                />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-3xl font-black tabular-nums">{countdown}s</span>
                <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{activePrediction.direction}</span>
              </div>
            </div>
          </div>
        )}

        {/* Recent Rounds */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-mono text-white/20 tracking-widest uppercase">Recent History</span>
          <div className="space-y-1.5">
            {decoratedRecent.map(({ p, stalePending }) => (
              <div key={p.id} className="flex items-center justify-between p-3 rounded-xl border border-white/[0.03] bg-white/[0.02]">
                <div className="flex items-center gap-2">
                  {p.direction === "long" ? <TrendingUp size={12} className="text-[#00E676]" /> : <TrendingDown size={12} className="text-[#FF1744]" />}
                  <span className="text-[11px] font-bold text-white/60">{p.amount} TC</span>
                </div>
                <div className={`text-[11px] font-black ${p.status === "won" ? "text-[#FFD700]" : p.status === "lost" ? "text-white/20" : "text-white/40"}`}>
                  {p.status === "won" ? `+${p.payout} GC` : p.status === "lost" ? "LOST" : "PENDING"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Result Overlay */}
      <AnimatePresence>
        {showResult && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-6"
            onClick={() => setShowResult(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              className={`w-full max-w-xs p-8 rounded-3xl border-2 text-center flex flex-col gap-4 ${
                showResult.won ? "border-[#FFD700] bg-[#FFD700]/5 shadow-[0_0_50px_rgba(255,215,0,0.2)]" : "border-white/10 bg-white/5"
              }`}
            >
              <div className="flex justify-center">
                {showResult.won ? <Crown size={48} className="text-[#FFD700]" /> : <Zap size={48} className="text-white/20" />}
              </div>
              <h2 className={`text-3xl font-black ${showResult.won ? "text-[#FFD700]" : "text-white/40"}`}>
                {showResult.won ? "WINNER!" : "LOST"}
              </h2>
              {showResult.won && (
                <div className="flex flex-col gap-1">
                  <span className="text-4xl font-black text-white">+{showResult.payout} GC</span>
                  <span className="text-sm text-white/40 font-mono">≈ {formatGcUsd(showResult.payout)}</span>
                </div>
              )}
              <button className="mt-4 py-3 rounded-xl bg-white/10 font-black text-xs tracking-widest uppercase">Tap to close</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, Crown, Flame, Gem, Shield, RotateCcw, Share2, Users, ChevronDown } from "lucide-react";
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
import { useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";

const MIN_BET = 50;
const DEFAULT_BET = 100;
const GOLD = "#FFD700";
const WIN_COLOR = "#00E676";
const LOSS_COLOR = "#FF1744";
const TC_BLUE = "#4DA3FF";

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
const DEFAULT_TIER_INDEX = 3;

interface TradingPair {
  id: string;
  label: string;
  short: string;
}
const TRADING_PAIRS: readonly TradingPair[] = [
  { id: "BTCUSDT", label: "BTC/USDT", short: "BTC" },
  { id: "ETHUSDT", label: "ETH/USDT", short: "ETH" },
  { id: "SOLUSDT", label: "SOL/USDT", short: "SOL" },
  { id: "BNBUSDT", label: "BNB/USDT", short: "BNB" },
  { id: "XRPUSDT", label: "XRP/USDT", short: "XRP" },
  { id: "DOGEUSDT", label: "DOGE/USDT", short: "DOGE" },
  { id: "ADAUSDT", label: "ADA/USDT", short: "ADA" },
];

const STALE_LIVE_GRACE_SEC = 15;

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

function VipTicker({ items }: { items: TickerItem[] }) {
  if (!items.length) return null;
  const doubled = [...items, ...items];
  return (
    <div className="relative overflow-hidden border-b border-white/5 h-7 bg-white/[0.02]">
      <div className="flex whitespace-nowrap absolute top-0 left-0 animate-ticker">
        {doubled.map((item, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 shrink-0 leading-7 pr-7">
            <span className="text-[10px]">👑</span>
            <span className="font-mono text-[10px] text-white/50">{item.displayName}</span>
            <span className="font-mono text-[10px] text-[#f5c518]">won {item.payout} GC</span>
            <span className="font-mono text-[9px] text-white/30">· {timeAgo(item.resolvedAt)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Terminal() {
  const { user, isLoading, refreshUser } = useTelegram();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [tierIndex, setTierIndex] = useState<number>(DEFAULT_TIER_INDEX);
  const [pairIndex, setPairIndex] = useState<number>(0);
  const selectedPair = TRADING_PAIRS[pairIndex] ?? TRADING_PAIRS[0];
  const [bet, setBet] = useState(DEFAULT_BET);
  const [activePrediction, setActivePrediction] = useState<any>(null);
  const [countdown, setCountdown] = useState(0);
  const [showResult, setShowResult] = useState<PriceResult | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [showPairMenu, setShowPairMenu] = useState(false);

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const { data: recentPredictions } = useGetUserPredictions(user?.telegramId ?? "", { limit: 5 }, { query: { enabled: !!user } });
  const { data: historyPredictions } = useGetUserPredictions(user?.telegramId ?? "", { limit: 100 }, { query: { enabled: !!user } });
  const { data: vipActivityRaw } = useGetVipActivity({ query: { refetchInterval: 30_000 } });
  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", { query: { enabled: !!user } });

  const vipActivity = useMemo(() => Array.isArray(vipActivityRaw) ? vipActivityRaw : [], [vipActivityRaw]);

  useEffect(() => {
    if (price <= 0) return;
    setPriceHistory(prev => [...prev, { t: Date.now(), v: price }].slice(-40));
  }, [price]);

  useEffect(() => {
    setPrice(0);
    setPriceHistory([]);
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${selectedPair.id.toLowerCase()}@ticker`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.c);
      setPrice(p => { setPrevPrice(p); return newPrice; });
    };
    return () => ws.close();
  }, [selectedPair.id]);

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || !price) return;
    try {
      const tier = DURATION_TIERS[tierIndex];
      const mult = tier.baseMultiplier + (isVipActive(user) ? VIP_MULTIPLIER_BONUS : 0);
      const pred = await createPrediction.mutateAsync({
        data: { telegramId: user.telegramId, direction, amount: bet, entryPrice: price, duration: tier.seconds, multiplier: mult }
      });
      setActivePrediction({ ...pred, duration: tier.seconds });
      setCountdown(tier.seconds);
      const timer = setInterval(() => {
        setCountdown(c => {
          if (c <= 1) { clearInterval(timer); return 0; }
          return c - 1;
        });
      }, 1000);
      setTimeout(async () => {
        const res = await resolvePrediction.mutateAsync({ params: { id: pred.id }, data: { exitPrice: price } });
        setActivePrediction(null);
        setShowResult({ ...pred, exitPrice: price, won: res.status === "won", payout: res.payout ?? 0 });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      }, tier.seconds * 1000);
    } catch {}
  };

  const vip = isVipActive(user);
  const referralCount = (userStats as any)?.referralCount ?? 0;
  const is5kLocked = !vip && referralCount < 5;
  const maxBet = vip ? 5000 : 1000;

  useEffect(() => {
    if (showResult?.won) {
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 }, colors: ["#FFD700", "#FFF9E0", "#B8860B"] });
    }
  }, [showResult]);

  if (isLoading) return <PageLoader rows={5} />;

  return (
    <div className="flex flex-col min-h-screen pb-20 bg-[#050508]">
      <style>{`
        @keyframes ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .animate-ticker { animation: ticker 30s linear infinite; }
      `}</style>

      <VipTicker items={vipActivity} />

      <div className="px-4 pt-4 flex flex-col gap-4">
        {/* Pair Selector & Price Display */}
        <div className="relative p-5 rounded-3xl border border-white/[0.06] bg-white/[0.03] flex flex-col gap-2 overflow-hidden">
          <div className="flex items-center justify-between relative z-10">
            <button onClick={() => setShowPairMenu(!showPairMenu)} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.05] border border-white/10">
              <span className="text-[10px] font-black text-white/40 tracking-widest">{selectedPair.label}</span>
              <ChevronDown size={12} className="text-white/30" />
            </button>
            <span className="text-[10px] font-mono text-white/20 tracking-widest uppercase">Live Terminal</span>
          </div>

          <AnimatePresence>
            {showPairMenu && (
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute top-14 left-5 z-20 bg-[#121218] border border-white/10 rounded-2xl p-2 grid grid-cols-2 gap-1 shadow-2xl">
                {TRADING_PAIRS.map((p, i) => (
                  <button key={p.id} onClick={() => { setPairIndex(i); setShowPairMenu(false); }} className={`px-4 py-2 rounded-xl text-left font-mono text-[10px] font-bold ${pairIndex === i ? "bg-[#FFD700] text-black" : "text-white/40 hover:bg-white/5"}`}>
                    {p.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-center gap-3 mt-2">
            <div className="w-10 h-10 rounded-full bg-white/[0.05] border border-white/10 flex items-center justify-center text-xs font-black text-white/40">
              {selectedPair.short}
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${price >= prevPrice ? "bg-[#00E676]" : "bg-[#FF1744]"} shadow-[0_0_10px_currentColor]`} />
                <h2 className="text-4xl font-black tracking-tighter tabular-nums">
                  ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </h2>
              </div>
            </div>
          </div>

          <div className="h-28 w-full mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priceHistory}>
                <Line type="monotone" dataKey="v" stroke={price >= prevPrice ? "#00E676" : "#FF1744"} strokeWidth={3} dot={false} isAnimationActive={false} />
                <YAxis hide domain={["auto", "auto"]} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Controls */}
        {!activePrediction && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-4 gap-2">
              {DURATION_TIERS.map((tier, idx) => (
                <button key={tier.seconds} onClick={() => setTierIndex(idx)} className={`py-2.5 rounded-2xl border font-mono text-[11px] font-black transition-all ${idx === tierIndex ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10" : "border-white/10 text-white/30"}`}>
                  {tier.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {[50, 100, 250, 500, 1000].map(opt => (
                <button key={opt} onClick={() => setBet(opt)} className={`flex-1 py-2.5 rounded-full font-mono text-[10px] font-bold border transition-all ${bet === opt ? "border-[#4DA3FF] text-[#8BC3FF] bg-[#4DA3FF]/10" : "border-white/10 text-white/30"}`}>
                  {opt >= 1000 ? `${opt/1000}K` : opt}
                </button>
              ))}
              <div className="relative flex-1">
                <button onClick={() => !is5kLocked && setBet(5000)} className={`w-full py-2.5 rounded-full font-mono text-[10px] font-bold border transition-all flex items-center justify-center gap-1 ${bet === 5000 ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10" : is5kLocked ? "border-white/5 text-white/10 bg-white/5 cursor-not-allowed" : "border-[#FFD700]/30 text-[#FFD700]/50"}`}>
                  {is5kLocked && <Users size={10} />} 5K
                </button>
                {is5kLocked && <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/80 border border-white/10 px-2 py-0.5 rounded text-[8px] font-mono text-white/40">Invite 5 friends</div>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => handlePredict("long")} disabled={!user || (user.tradeCredits ?? 0) < bet} className="py-5 rounded-3xl border-2 font-mono font-black text-xl bg-[#00E676]/10 border-[#00E676]/40 text-[#00E676] disabled:opacity-20 uppercase tracking-widest shadow-[0_0_20px_rgba(0,230,118,0.1)]">Long</button>
              <button onClick={() => handlePredict("short")} disabled={!user || (user.tradeCredits ?? 0) < bet} className="py-5 rounded-3xl border-2 font-mono font-black text-xl bg-[#FF1744]/10 border-[#FF1744]/40 text-[#FF1744] disabled:opacity-20 uppercase tracking-widest shadow-[0_0_20px_rgba(255,23,68,0.1)]">Short</button>
            </div>
          </div>
        )}

        {activePrediction && (
          <div className="flex flex-col items-center py-6">
            <div className="relative w-36 h-36 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90">
                <circle cx="72" cy="72" r="68" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                <circle cx="72" cy="72" r="68" fill="none" stroke="#FFD700" strokeWidth="6" strokeDasharray={427} strokeDashoffset={427 * (1 - countdown / activePrediction.duration)} strokeLinecap="round" className="transition-all duration-1000 linear" />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-4xl font-black tabular-nums">{countdown}s</span>
                <span className="text-[10px] font-mono text-white/30 uppercase tracking-[0.2em]">{activePrediction.direction}</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-2">
          <span className="text-[10px] font-mono text-white/20 tracking-[0.3em] uppercase">Recent History</span>
          <div className="space-y-2">
            {(recentPredictions ?? []).slice(0, 5).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between p-4 rounded-2xl border border-white/[0.04] bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  {p.direction === "long" ? <TrendingUp size={14} className="text-[#00E676]" /> : <TrendingDown size={14} className="text-[#FF1744]" />}
                  <div className="flex flex-col">
                    <span className="text-xs font-black text-white/80">{p.amount} TC</span>
                    <span className="text-[9px] font-mono text-white/30 uppercase tracking-tighter">{p.direction} · {p.duration}s</span>
                  </div>
                </div>
                <div className={`text-xs font-black ${p.status === "won" ? "text-[#FFD700]" : p.status === "lost" ? "text-white/20" : "text-white/40"}`}>
                  {p.status === "won" ? `+${p.payout} GC` : p.status === "lost" ? "LOST" : "LIVE"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showResult && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md p-6" onClick={() => setShowResult(null)}>
            <motion.div initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} className={`w-full max-w-xs p-10 rounded-[40px] border-2 text-center flex flex-col gap-6 ${showResult.won ? "border-[#FFD700] bg-[#FFD700]/5 shadow-[0_0_60px_rgba(255,215,0,0.15)]" : "border-white/10 bg-white/5"}`}>
              <div className="flex justify-center">{showResult.won ? <Crown size={56} className="text-[#FFD700]" /> : <Zap size={56} className="text-white/10" />}</div>
              <div className="flex flex-col gap-1">
                <h2 className={`text-4xl font-black tracking-tighter ${showResult.won ? "text-[#FFD700]" : "text-white/30"}`}>{showResult.won ? "PROFIT!" : "LOSS"}</h2>
                <span className="text-[10px] font-mono text-white/20 tracking-[0.3em] uppercase">{showResult.won ? "Trade Successful" : "Trade Failed"}</span>
              </div>
              {showResult.won && (
                <div className="flex flex-col gap-1">
                  <span className="text-5xl font-black text-white tracking-tighter">+{showResult.payout}</span>
                  <span className="text-xs text-white/30 font-mono">GOLD COINS AWARDED</span>
                </div>
              )}
              <button className="mt-4 py-4 rounded-2xl bg-white/5 border border-white/10 font-black text-[10px] tracking-widest uppercase text-white/40">Tap to continue</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

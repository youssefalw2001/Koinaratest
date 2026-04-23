import { useState, useEffect, useMemo } from "react";
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

const GOLD = "#FFD700";
const BULL_COLOR = "#00E676";
const BEAR_COLOR = "#FF1744";
const FAST_CANDLE_MS = 5_000;
const MAX_CHART_CANDLES = 60;

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

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function LinePriceChart({
  candles,
  price,
  prevPrice,
  entryPrice,
}: {
  candles: Candle[];
  price: number;
  prevPrice: number;
  entryPrice: number | null;
}) {
  const chart = useMemo(() => {
    if (!candles.length) return { points: [], path: "", areaPath: "", min: 0, max: 0 };
    const closes = candles.map(c => c.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = Math.max(max - min, 1e-6);
    const sampleCount = Math.max(candles.length - 1, 1);
    const points = candles.map((c, idx) => {
      const x = (idx / sampleCount) * 100;
      const y = 100 - ((c.close - min) / span) * 100;
      return { x, y };
    });
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    const areaPath = `${path} L 100 100 L 0 100 Z`;
    return { points, path, areaPath, min, max };
  }, [candles]);

  const priceY = useMemo(() => {
    if (!chart.points.length) return null;
    const span = Math.max(chart.max - chart.min, 1e-6);
    return 100 - ((price - chart.min) / span) * 100;
  }, [chart, price]);
  const entryY = useMemo(() => {
    if (!chart.points.length || entryPrice === null) return null;
    const span = Math.max(chart.max - chart.min, 1e-6);
    return 100 - ((entryPrice - chart.min) / span) * 100;
  }, [chart, entryPrice]);
  const lastPoint = chart.points[chart.points.length - 1];
  const trendUp = price >= prevPrice;

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
      <defs>
        <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={trendUp ? "rgba(0,230,118,0.35)" : "rgba(255,23,68,0.35)"} />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      {[20, 40, 60, 80].map((y) => (
        <line key={`grid-${y}`} x1={0} x2={100} y1={y} y2={y} stroke="rgba(255,255,255,0.08)" strokeWidth={0.25} />
      ))}
      {!!chart.path && <path d={chart.areaPath} fill="url(#lineFill)" opacity={0.8} />}
      {!!chart.path && (
        <path
          d={chart.path}
          fill="none"
          stroke={trendUp ? BULL_COLOR : BEAR_COLOR}
          strokeWidth={1.1}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {priceY !== null && priceY >= 0 && priceY <= 100 && (
        <line
          x1={0}
          x2={100}
          y1={priceY}
          y2={priceY}
          stroke={price >= prevPrice ? BULL_COLOR : BEAR_COLOR}
          strokeWidth={0.35}
          strokeDasharray="1.2 1.2"
          opacity={0.75}
        />
      )}
      {entryY !== null && entryY >= 0 && entryY <= 100 && (
        <>
          <line
            x1={0}
            x2={100}
            y1={entryY}
            y2={entryY}
            stroke={GOLD}
            strokeWidth={0.45}
            strokeDasharray="2 1.4"
            opacity={0.95}
          />
          <rect x={0.8} y={Math.max(0, entryY - 2.8)} width={15} height={5.6} rx={1.2} fill="rgba(255, 215, 0, 0.18)" />
          <text x={2.1} y={Math.min(98, Math.max(4, entryY + 1.2))} fill={GOLD} fontSize={3.3} fontWeight={700}>
            ENTRY
          </text>
        </>
      )}
      {lastPoint && (
        <>
          <circle cx={lastPoint.x} cy={lastPoint.y} r={1.5} fill={trendUp ? BULL_COLOR : BEAR_COLOR} />
          <circle cx={lastPoint.x} cy={lastPoint.y} r={2.9} fill={trendUp ? "rgba(0,230,118,0.15)" : "rgba(255,23,68,0.15)"} />
        </>
      )}
    </svg>
  );
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

export default function Terminal() {
  const { user, isLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [tierIndex, setTierIndex] = useState<number>(3);
  const [pairIndex, setPairIndex] = useState<number>(0);
  const selectedPair = TRADING_PAIRS[pairIndex] ?? TRADING_PAIRS[0];
  const [bet, setBet] = useState(100);
  const [activePrediction, setActivePrediction] = useState<any>(null);
  const [countdown, setCountdown] = useState(0);
  const [showResult, setShowResult] = useState<any>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [showPairMenu, setShowPairMenu] = useState(false);
  const [sentiment, setSentiment] = useState(55); // Default 55% bullish

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const { data: recentPredictions } = useGetUserPredictions(user?.telegramId ?? "", { limit: 5 }, { query: { enabled: !!user, queryKey: ["predictions", user?.telegramId] } });
  const { data: vipActivityRaw } = useGetVipActivity({ query: { refetchInterval: 30_000, queryKey: ["vip-activity"] } });
  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: ["user-stats", user?.telegramId] } });

  const vipActivity = useMemo(() => Array.isArray(vipActivityRaw) ? vipActivityRaw : [], [vipActivityRaw]);
  const topLeaders = useMemo(
    () => [...vipActivity]
      .sort((a: any, b: any) => Number(b?.payout ?? 0) - Number(a?.payout ?? 0))
      .slice(0, 3),
    [vipActivity],
  );

  // Candle Engine & Sentiment Generator
  useEffect(() => {
    setPrice(0);
    setCandles([]);
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${selectedPair.id.toLowerCase()}@trade`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.p);
      const tradeTime = Number(data.T || Date.now());
      const bucketTime = Math.floor(tradeTime / FAST_CANDLE_MS) * FAST_CANDLE_MS;
      setPrice(p => { setPrevPrice(p); return newPrice; });

      setCandles(prev => {
        const last = prev[prev.length - 1];
        if (last && last.time === bucketTime) {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            high: Math.max(last.high, newPrice),
            low: Math.min(last.low, newPrice),
            close: newPrice,
          };
          return updated;
        }
        const open = last?.close ?? newPrice;
        const newCandle: Candle = {
          time: bucketTime,
          open,
          high: Math.max(open, newPrice),
          low: Math.min(open, newPrice),
          close: newPrice,
        };
        return [...prev, newCandle].slice(-MAX_CHART_CANDLES);
      });

    };

    // Randomize sentiment occasionally for "Live" feel
    const sInt = setInterval(() => {
      setSentiment(prev => {
        const delta = (Math.random() - 0.5) * 4;
        return Math.min(85, Math.max(15, prev + delta));
      });
    }, 5000);

    return () => { ws.close(); clearInterval(sInt); };
  }, [selectedPair.id]);

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || !price) return;
    try {
      const tier = DURATION_TIERS[tierIndex];
      const mult = tier.baseMultiplier + (isVipActive(user) ? VIP_MULTIPLIER_BONUS : 0);
      const pred = await createPrediction.mutateAsync({
        data: { telegramId: user.telegramId, direction, amount: bet, entryPrice: price, duration: tier.seconds, multiplier: mult }
      });
      setActivePrediction({ ...pred, duration: tier.seconds, entryPrice: price, openedAt: Date.now() });
      setCountdown(tier.seconds);
      const timer = setInterval(() => {
        setCountdown(c => {
          if (c <= 1) { clearInterval(timer); return 0; }
          return c - 1;
        });
      }, 1000);
      setTimeout(async () => {
        const res = await resolvePrediction.mutateAsync({ id: pred.id, data: { exitPrice: price } });
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

  useEffect(() => {
    if (showResult?.won) {
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ["#FFD700", "#FFF9E0", "#B8860B"] });
    }
  }, [showResult]);

  if (isLoading) return <PageLoader rows={5} />;

  return (
    <div className="flex flex-col min-h-screen pb-20 bg-[#050508]">
      <style>{`
        @keyframes ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .animate-ticker { animation: ticker 30s linear infinite; }
        .gold-glow { text-shadow: 0 0 15px rgba(255, 215, 0, 0.4); }
        .candle-container { filter: drop-shadow(0 0 10px rgba(0,0,0,0.5)); }
      `}</style>

      {/* VIP Ticker */}
      <div className="relative overflow-hidden border-b border-white/5 h-7 bg-white/[0.02]">
        <div className="flex whitespace-nowrap absolute top-0 left-0 animate-ticker">
          {(vipActivity.length ? [...vipActivity, ...vipActivity] : []).map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 shrink-0 leading-7 pr-7">
              <span className="text-[10px]">👑</span>
              <span className="font-mono text-[10px] text-white/50">{item.displayName}</span>
              <span className="font-mono text-[10px] text-[#FFD700]">won {item.payout} GC</span>
              <span className="font-mono text-[9px] text-white/30">· {timeAgo(item.resolvedAt)}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 flex flex-col gap-4">
        {/* Elite Terminal Header */}
        <div className="relative p-6 rounded-[32px] border border-white/[0.08] bg-gradient-to-b from-white/[0.05] to-transparent flex flex-col gap-2 overflow-hidden shadow-2xl">
          <div className="flex items-center justify-between relative z-10">
            <button onClick={() => setShowPairMenu(!showPairMenu)} className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/[0.05] border border-white/10 hover:bg-white/10 transition-all">
              <span className="text-[11px] font-black text-[#FFD700] tracking-widest uppercase">{selectedPair.label}</span>
              <ChevronDown size={14} className="text-[#FFD700]/50" />
            </button>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#00E676] animate-pulse" />
                <span className="text-[10px] font-mono text-white/30 tracking-widest uppercase">Live</span>
              </div>
            </div>
          </div>

          <AnimatePresence>
            {showPairMenu && (
              <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="absolute top-16 left-6 z-20 bg-[#121218] border border-white/10 rounded-2xl p-2 grid grid-cols-1 gap-1 shadow-2xl min-w-[140px]">
                {TRADING_PAIRS.map((p, i) => (
                  <button key={p.id} onClick={() => { setPairIndex(i); setShowPairMenu(false); }} className={`px-4 py-3 rounded-xl text-left font-mono text-[11px] font-black flex justify-between items-center ${pairIndex === i ? "bg-[#FFD700] text-black" : "text-white/40 hover:bg-white/5"}`}>
                    <span>{p.label}</span>
                    <span className="opacity-40">{p.symbol}</span>
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex items-end justify-between mt-4">
            <div className="flex flex-col">
              <span className={`text-4xl font-black tracking-tighter tabular-nums ${price >= prevPrice ? "text-[#00E676]" : "text-[#FF1744]"}`}>
                ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-[10px] font-black uppercase tracking-widest ${price >= prevPrice ? "text-[#00E676]" : "text-[#FF1744]"}`}>
                  {price >= prevPrice ? "Rising" : "Falling"}
                </span>
                <span className="text-[10px] font-mono text-white/20">· Realtime Binance Feed</span>
              </div>
            </div>
            <div className="w-12 h-12 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center text-xl font-black text-[#FFD700]/40">
              {selectedPair.symbol}
            </div>
          </div>

          {/* Top Leaderboard (restored) */}
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[9px] font-black tracking-[0.22em] text-white/40 uppercase">Top Payouts</span>
              <span className="text-[9px] font-mono text-[#FFD700]/70 uppercase">Live board</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(topLeaders.length ? topLeaders : [{ displayName: "Waiting...", payout: 0 }, { displayName: "Waiting...", payout: 0 }, { displayName: "Waiting...", payout: 0 }]).map((entry: any, idx: number) => (
                <div key={`${entry.displayName}-${idx}`} className="rounded-xl border border-white/10 bg-black/25 p-2">
                  <div className="flex items-center gap-1.5">
                    <Crown size={10} className={`${idx === 0 ? "text-[#FFD700]" : idx === 1 ? "text-[#8BC3FF]" : "text-[#ff8fb2]"}`} />
                    <span className="font-mono text-[9px] text-white/70 truncate">{entry.displayName}</span>
                  </div>
                  <div className="mt-1 font-mono text-[10px] font-black text-[#FFD700]">{Number(entry.payout ?? 0).toFixed(0)} GC</div>
                </div>
              ))}
            </div>
          </div>

          {/* Line Chart */}
          <div className="h-40 w-full mt-6 candle-container">
            <LinePriceChart candles={candles} price={price} prevPrice={prevPrice} entryPrice={activePrediction?.entryPrice ?? null} />
          </div>

          {/* Sentiment Bar */}
          <div className="mt-4 flex flex-col gap-1.5">
            <div className="flex justify-between text-[8px] font-black tracking-[0.2em] uppercase">
              <span className="text-[#00E676]">Bulls {sentiment.toFixed(0)}%</span>
              <span className="text-[#FF1744]">Bears {(100 - sentiment).toFixed(0)}%</span>
            </div>
            <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden flex">
              <motion.div animate={{ width: `${sentiment}%` }} className="h-full bg-[#00E676] shadow-[0_0_8px_#00E676]" />
              <motion.div animate={{ width: `${100 - sentiment}%` }} className="h-full bg-[#FF1744] shadow-[0_0_8px_#FF1744]" />
            </div>
          </div>
        </div>

        {/* Binary Options Controls */}
        {!activePrediction && (
          <div className="flex flex-col gap-5 mt-2">
            <div className="grid grid-cols-4 gap-2">
              {DURATION_TIERS.map((tier, idx) => (
                <button key={tier.seconds} onClick={() => setTierIndex(idx)} className={`py-3 rounded-2xl border font-mono text-[11px] font-black transition-all ${idx === tierIndex ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10 shadow-[0_0_15px_rgba(255,215,0,0.1)]" : "border-white/5 text-white/20 bg-white/[0.02]"}`}>
                  {tier.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              {[50, 100, 250, 500, 1000].map(opt => (
                <button key={opt} onClick={() => setBet(opt)} className={`flex-1 py-3 rounded-2xl font-mono text-[10px] font-black border transition-all ${bet === opt ? "border-[#4DA3FF] text-[#8BC3FF] bg-[#4DA3FF]/10" : "border-white/5 text-white/20 bg-white/[0.02]"}`}>
                  {opt >= 1000 ? `${opt/1000}K` : opt}
                </button>
              ))}
              <div className="relative flex-1">
                <button onClick={() => !is5kLocked && setBet(5000)} className={`w-full py-3 rounded-2xl font-mono text-[10px] font-black border transition-all flex items-center justify-center gap-1 ${bet === 5000 ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/10" : is5kLocked ? "border-white/5 text-white/10 bg-white/5 cursor-not-allowed" : "border-[#FFD700]/30 text-[#FFD700]/50 bg-[#FFD700]/5"}`}>
                  {is5kLocked && <Users size={10} />} 5K
                </button>
                {is5kLocked && <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/90 border border-white/10 px-3 py-1 rounded-lg text-[9px] font-black text-[#FFD700]/60">INVITE 5 FRIENDS</div>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-2">
              <button onClick={() => handlePredict("long")} disabled={!user || (user.tradeCredits ?? 0) < bet} className="group relative py-6 rounded-[32px] border-2 font-black text-2xl bg-[#00E676]/5 border-[#00E676]/30 text-[#00E676] disabled:opacity-20 uppercase tracking-widest overflow-hidden transition-all hover:bg-[#00E676]/10 active:scale-95">
                <div className="relative z-10 flex items-center justify-center gap-2">
                  <TrendingUp size={24} />
                  LONG
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[#00E676]/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              <button onClick={() => handlePredict("short")} disabled={!user || (user.tradeCredits ?? 0) < bet} className="group relative py-6 rounded-[32px] border-2 font-black text-2xl bg-[#FF1744]/5 border-[#FF1744]/30 text-[#FF1744] disabled:opacity-20 uppercase tracking-widest overflow-hidden transition-all hover:bg-[#FF1744]/10 active:scale-95">
                <div className="relative z-10 flex items-center justify-center gap-2">
                  <TrendingDown size={24} />
                  SHORT
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[#FF1744]/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
          </div>
        )}

        {activePrediction && (
          <div className="flex flex-col items-center py-8">
            <div className="relative w-40 h-40 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90">
                <circle cx="80" cy="80" r="76" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="8" />
                <circle cx="80" cy="80" r="76" fill="none" stroke="#FFD700" strokeWidth="8" strokeDasharray={477} strokeDashoffset={477 * (1 - countdown / activePrediction.duration)} strokeLinecap="round" className="transition-all duration-1000 linear shadow-[0_0_20px_#FFD700]" />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="text-5xl font-black tabular-nums tracking-tighter">{countdown}s</span>
                <span className="text-[11px] font-black text-[#FFD700] uppercase tracking-[0.3em] mt-1">{activePrediction.direction}</span>
              </div>
            </div>
          </div>
        )}

        {/* History List */}
        <div className="flex flex-col gap-3 mt-4">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] font-black text-white/30 tracking-[0.3em] uppercase">Market History</span>
            <span className="text-[10px] font-mono text-white/20">Last 5 Trades</span>
          </div>
          <div className="space-y-2">
            {(recentPredictions ?? []).slice(0, 5).map((p: any) => (
              <div key={p.id} className="flex items-center justify-between p-5 rounded-[24px] border border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.04] transition-all">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center ${p.direction === "long" ? "bg-[#00E676]/10 text-[#00E676]" : "bg-[#FF1744]/10 text-[#FF1744]"}`}>
                    {p.direction === "long" ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-black text-white">{p.amount} TC</span>
                    <span className="text-[10px] font-mono text-white/30 uppercase tracking-tighter">{p.duration}s · ${p.entryPrice.toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end">
                  <span className={`text-sm font-black ${p.status === "won" ? "text-[#FFD700] gold-glow" : p.status === "lost" ? "text-white/10" : "text-white/40"}`}>
                    {p.status === "won" ? `+${p.payout} GC` : p.status === "lost" ? "LOSS" : "PENDING"}
                  </span>
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-tighter">{timeAgo(p.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Result Modal */}
      <AnimatePresence>
        {showResult && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/98 backdrop-blur-xl p-6" onClick={() => setShowResult(null)}>
            <motion.div initial={{ scale: 0.9, y: 30 }} animate={{ scale: 1, y: 0 }} className={`w-full max-w-sm p-12 rounded-[48px] border-2 text-center flex flex-col gap-8 ${showResult.won ? "border-[#FFD700] bg-gradient-to-b from-[#FFD700]/10 to-transparent shadow-[0_0_100px_rgba(255,215,0,0.2)]" : "border-white/10 bg-white/5"}`}>
              <div className="flex justify-center">
                <div className={`w-24 h-24 rounded-[32px] flex items-center justify-center ${showResult.won ? "bg-[#FFD700] text-black shadow-[0_0_40px_#FFD700]" : "bg-white/5 text-white/10"}`}>
                  {showResult.won ? <Crown size={48} /> : <Zap size={48} />}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <h2 className={`text-5xl font-black tracking-tighter ${showResult.won ? "text-[#FFD700] gold-glow" : "text-white/20"}`}>{showResult.won ? "ELITE WIN!" : "TRADE LOSS"}</h2>
                <span className="text-[11px] font-black text-white/30 tracking-[0.4em] uppercase">{showResult.won ? "Liquidity Secured" : "Market Volatility"}</span>
              </div>
              {showResult.won && (
                <div className="flex flex-col gap-1">
                  <span className="text-6xl font-black text-white tracking-tighter">+{showResult.payout}</span>
                  <span className="text-xs text-[#FFD700] font-black tracking-widest uppercase">GOLD COINS EARNED</span>
                </div>
              )}
              <button className="mt-4 py-5 rounded-3xl bg-white/5 border border-white/10 font-black text-xs tracking-[0.3em] uppercase text-white/30 hover:bg-white/10 transition-all">TAP TO DISMISS</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

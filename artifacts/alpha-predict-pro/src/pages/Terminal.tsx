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
const TICK_INTERVAL_MS = 1_000; // aggregate ticks into 1-second points for smoothness
const MAX_POINTS = 120; // 2 minutes of data at 1 point/sec
const CHART_W = 600;
const CHART_H = 200;
const CHART_PAD_Y = 16;

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

interface PricePoint {
  time: number;
  price: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SMOOTH CHART — Catmull-Rom spline → SVG cubic bezier
   ═══════════════════════════════════════════════════════════════════════════ */
function catmullRomToBezier(
  pts: { x: number; y: number }[],
  tension = 0.35,
): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

  let d = `M${pts[0].x},${pts[0].y}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];

    const cp1x = p1.x + ((p2.x - p0.x) * tension) / 3;
    const cp1y = p1.y + ((p2.y - p0.y) * tension) / 3;
    const cp2x = p2.x - ((p3.x - p1.x) * tension) / 3;
    const cp2y = p2.y - ((p3.y - p1.y) * tension) / 3;

    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

function SmoothPriceChart({
  points,
  entryPrice,
  currentPrice,
  prevPrice,
}: {
  points: PricePoint[];
  entryPrice: number | null;
  currentPrice: number;
  prevPrice: number;
}) {
  const trendUp = currentPrice >= prevPrice;
  const lineColor = trendUp ? BULL_COLOR : BEAR_COLOR;

  const { svgPath, areaPath, lastPt, entryY, priceY, priceLabels } = useMemo(() => {
    if (points.length < 2)
      return { svgPath: "", areaPath: "", lastPt: null, entryY: null, priceY: null, priceLabels: [] as { y: number; label: string }[] };

    const prices = points.map((p) => p.price);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const span = Math.max(maxP - minP, 1e-6);

    const toY = (p: number) => CHART_PAD_Y + ((maxP - p) / span) * (CHART_H - CHART_PAD_Y * 2);
    const toX = (idx: number) => (idx / Math.max(points.length - 1, 1)) * CHART_W;

    const mapped = points.map((pt, i) => ({ x: toX(i), y: toY(pt.price) }));
    const svgP = catmullRomToBezier(mapped);
    const last = mapped[mapped.length - 1];
    const areaP = `${svgP} L${last.x},${CHART_H} L${mapped[0].x},${CHART_H} Z`;

    const eY = entryPrice !== null ? toY(entryPrice) : null;
    const pY = toY(currentPrice);

    // Price labels for Y axis
    const steps = 4;
    const labels: { y: number; label: string }[] = [];
    for (let i = 0; i <= steps; i++) {
      const p = minP + (span * i) / steps;
      labels.push({ y: toY(p), label: p.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) });
    }

    return { svgPath: svgP, areaPath: areaP, lastPt: last, entryY: eY, priceY: pY, priceLabels: labels };
  }, [points, entryPrice, currentPrice]);

  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="w-full h-full">
      <defs>
        {/* Line gradient fill */}
        <linearGradient id="chartAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={trendUp ? "rgba(0,230,118,0.25)" : "rgba(255,23,68,0.25)"} />
          <stop offset="70%" stopColor={trendUp ? "rgba(0,230,118,0.05)" : "rgba(255,23,68,0.05)"} />
          <stop offset="100%" stopColor="rgba(0,0,0,0)" />
        </linearGradient>
        {/* Line glow filter */}
        <filter id="lineGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Dot glow */}
        <filter id="dotGlow" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Entry line glow */}
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
        const y = CHART_PAD_Y + frac * (CHART_H - CHART_PAD_Y * 2);
        return (
          <line
            key={`g-${frac}`}
            x1={0}
            x2={CHART_W}
            y1={y}
            y2={y}
            stroke="rgba(255,255,255,0.04)"
            strokeWidth={0.8}
          />
        );
      })}

      {/* Price labels on right */}
      {priceLabels.map((l, i) => (
        <text
          key={`pl-${i}`}
          x={CHART_W - 4}
          y={l.y - 3}
          textAnchor="end"
          fill="rgba(255,255,255,0.12)"
          fontSize={8}
          fontFamily="monospace"
        >
          {l.label}
        </text>
      ))}

      {/* Area fill */}
      {areaPath && <path d={areaPath} fill="url(#chartAreaFill)" />}

      {/* Smooth line with glow */}
      {svgPath && (
        <path
          d={svgPath}
          fill="none"
          stroke={lineColor}
          strokeWidth={2.2}
          strokeLinejoin="round"
          strokeLinecap="round"
          filter="url(#lineGlow)"
        />
      )}

      {/* Current price dashed line */}
      {priceY !== null && priceY >= 0 && priceY <= CHART_H && (
        <>
          <line
            x1={0}
            x2={CHART_W}
            y1={priceY}
            y2={priceY}
            stroke={lineColor}
            strokeWidth={0.6}
            strokeDasharray="6 4"
            opacity={0.5}
          />
          {/* Price tag on right */}
          <rect
            x={CHART_W - 68}
            y={priceY - 9}
            width={66}
            height={18}
            rx={4}
            fill={lineColor}
            opacity={0.9}
          />
          <text
            x={CHART_W - 35}
            y={priceY + 3.5}
            textAnchor="middle"
            fill={trendUp ? "#000" : "#FFF"}
            fontSize={9}
            fontWeight={800}
            fontFamily="monospace"
          >
            ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </text>
        </>
      )}

      {/* Entry price line (gold, animated) */}
      {entryY !== null && entryY >= 0 && entryY <= CHART_H && (
        <>
          <line
            x1={0}
            x2={CHART_W}
            y1={entryY}
            y2={entryY}
            stroke={GOLD}
            strokeWidth={1.2}
            strokeDasharray="8 5"
            opacity={0.9}
            filter="url(#entryGlow)"
          />
          {/* Entry label on left */}
          <rect
            x={2}
            y={entryY - 10}
            width={52}
            height={20}
            rx={5}
            fill="rgba(255,215,0,0.2)"
            stroke={GOLD}
            strokeWidth={0.6}
          />
          <text
            x={28}
            y={entryY + 3.5}
            textAnchor="middle"
            fill={GOLD}
            fontSize={9}
            fontWeight={900}
            fontFamily="monospace"
          >
            ENTRY
          </text>
        </>
      )}

      {/* Live dot at the end of the line */}
      {lastPt && (
        <>
          {/* Outer glow ring */}
          <circle
            cx={lastPt.x}
            cy={lastPt.y}
            r={8}
            fill={lineColor}
            opacity={0.15}
            filter="url(#dotGlow)"
          >
            <animate attributeName="r" values="6;10;6" dur="2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.15;0.05;0.15" dur="2s" repeatCount="indefinite" />
          </circle>
          {/* Inner dot */}
          <circle cx={lastPt.x} cy={lastPt.y} r={3.5} fill={lineColor}>
            <animate attributeName="r" values="3;4.5;3" dur="1.5s" repeatCount="indefinite" />
          </circle>
          <circle cx={lastPt.x} cy={lastPt.y} r={1.5} fill="#fff" opacity={0.9} />
        </>
      )}
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
  const [pricePoints, setPricePoints] = useState<PricePoint[]>([]);
  const latestPriceRef = useRef<number>(0);

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

  /* ─── WebSocket price feed ─────────────────────────────────────────── */
  useEffect(() => {
    setPrice(0);
    setPrevPrice(0);
    setPricePoints([]);
    latestPriceRef.current = 0;

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/ws/${selectedPair.id.toLowerCase()}@trade`,
    );

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const newPrice = parseFloat(data.p);
      latestPriceRef.current = newPrice;
      setPrice((p) => {
        setPrevPrice(p);
        return newPrice;
      });
    };

    // Sample the latest price every TICK_INTERVAL_MS for smooth chart
    const sampler = setInterval(() => {
      const p = latestPriceRef.current;
      if (p <= 0) return;
      setPricePoints((prev) => {
        const now = Date.now();
        const next = [...prev, { time: now, price: p }];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
      });
    }, TICK_INTERVAL_MS);

    // Sentiment drift
    const sInt = setInterval(() => {
      setSentiment((prev) => {
        const delta = (Math.random() - 0.5) * 4;
        return Math.min(85, Math.max(15, prev + delta));
      });
    }, 5000);

    return () => {
      ws.close();
      clearInterval(sampler);
      clearInterval(sInt);
    };
  }, [selectedPair.id]);

  /* ─── Trade handler ────────────────────────────────────────────────── */
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
          const currentP = latestPriceRef.current || price;
          const res = await resolvePrediction.mutateAsync({
            id: pred.id,
            data: { exitPrice: currentP },
          });
          setActivePrediction(null);
          setShowResult({
            ...pred,
            exitPrice: currentP,
            won: res.status === "won",
            payout: res.payout ?? 0,
          });
          refreshUser();
          queryClient.invalidateQueries({
            queryKey: getGetUserQueryKey(user.telegramId),
          });
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
    if (pricePoints.length < 2) return 0;
    const first = pricePoints[0].price;
    return ((price - first) / first) * 100;
  }, [pricePoints, price]);

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

          {/* ── Smooth Chart ──────────────────────────────────────────── */}
          <div className="h-44 w-full mt-4 px-2">
            <SmoothPriceChart
              points={pricePoints}
              entryPrice={activePrediction?.entryPrice ?? null}
              currentPrice={price}
              prevPrice={prevPrice}
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
                      ? `+${p.payout} GC`
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
              <button className="mt-2 py-4 rounded-2xl bg-white/5 border border-white/10 font-black text-xs tracking-[0.2em] uppercase text-white/30 hover:bg-white/10 transition-all active:scale-95">
                TAP TO DISMISS
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

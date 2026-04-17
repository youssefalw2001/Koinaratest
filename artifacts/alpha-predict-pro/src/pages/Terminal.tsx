import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, Crown, Flame, Gem, Shield, RotateCcw } from "lucide-react";
import {
  BarChart,
  Bar,
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
} from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { useTelegram } from "@/lib/TelegramProvider";
import { formatGcUsd } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";

const MIN_BET = 50;
const DEFAULT_BET = 100;
const CLOSE_CALL_THRESHOLD = 5;

// Round duration tiers: (seconds, base multiplier, label). VIP users get +0.1
// on top of the base multiplier. The server validates the multiplier against
// the selected duration, so these values must stay in sync with
// DURATION_TIERS in api-server/src/routes/predictions.ts.
interface DurationTier {
  seconds: number;
  baseMultiplier: number;
  label: string;
}
const DURATION_TIERS = [
  { seconds: 6   as const, baseMultiplier: 1.7, label: "6s"  },
  { seconds: 15  as const, baseMultiplier: 2.0, label: "15s" },
  { seconds: 30  as const, baseMultiplier: 2.3, label: "30s" },
  { seconds: 60  as const, baseMultiplier: 2.8, label: "1m"  },
  { seconds: 300 as const, baseMultiplier: 3.5, label: "5m"  },
] satisfies readonly DurationTier[];
const VIP_MULTIPLIER_BONUS = 0.1;
const DEFAULT_TIER_INDEX = 3; // 60s — matches the old behaviour
const CANDLE_COUNT = 60;
const CANDLE_BUCKET_MS = 1000;
// Grace windows added on top of each prediction's own `duration` before the
// UI considers it stale or auto-resolves it. Kept < the backend sweeper's
// grace so the client usually resolves first.
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

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
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

interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  range: [number, number];
  body: [number, number];
}

interface WickShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Candle;
}

function WickShape(props: WickShapeProps) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const isUp = payload.close >= payload.open;
  const color = isUp ? "#00f0ff" : "#ff2d78";
  const cx = x + width / 2;
  return (
    <line
      x1={cx}
      x2={cx}
      y1={y}
      y2={y + Math.max(1, height)}
      stroke={color}
      strokeWidth={1}
      opacity={0.6}
    />
  );
}

interface BodyShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Candle;
}

function BodyShape(props: BodyShapeProps) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const isUp = payload.close >= payload.open;
  const color = isUp ? "#00f0ff" : "#ff2d78";
  const cx = x + width / 2;
  const bodyW = Math.max(2, Math.min(width * 0.7, 8));
  return (
    <rect
      x={cx - bodyW / 2}
      y={y}
      width={bodyW}
      height={Math.max(1, height)}
      fill={color}
      opacity={0.95}
      style={{ filter: `drop-shadow(0 0 3px ${color})` }}
    />
  );
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
              won {item.payout} GC
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
  const { user } = useTelegram();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [tierIndex, setTierIndex] = useState<number>(DEFAULT_TIER_INDEX);
  const [tickDir, setTickDir] = useState<"up" | "down" | null>(null);
  const candlesRef = useRef<Candle[]>([]);
  const [candleData, setCandleData] = useState<Candle[]>([]);
  const reconcileRunRef = useRef(false);
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
  const [winStreak, setWinStreak] = useState(0);
  const [lossStreak, setLossStreak] = useState(0);
  const [showCloseCall, setShowCloseCall] = useState(false);
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
  const winStreakRef = useRef(0);
  const lossStreakRef = useRef(0);
  const priceRef = useRef<number>(0);
  const synthRef = useRef<TickerItem[]>([]);
  if (synthRef.current.length === 0) {
    synthRef.current = Array.from({ length: 10 }, (_, i) => makeSynth(2 + i * 4));
  }

  const [donPredictionId, setDonPredictionId] = useState<number | null>(null);

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const purchaseGem = usePurchaseGem();

  const { data: activeGems, refetch: refetchGems } = useGetActiveGems(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") },
  });

  const activePowerupNames = (activeGems ?? [])
    .filter((g) => g.usesRemaining > 0)
    .map((g) => g.gemType);

  const hasStreakSaver = activePowerupNames.includes("streak_saver");
  const hasStarterBoost = activePowerupNames.includes("starter_boost");
  const hasBigSwing = activePowerupNames.includes("big_swing");

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

  const vipActivity: TickerItem[] = (() => {
    const real = vipActivityRaw ?? [];
    if (real.length >= 10) return real;
    const needed = 10 - real.length;
    return [...real, ...synthRef.current.slice(0, Math.max(0, needed))];
  })();

  useEffect(() => {
    if (price <= 0) return;
    priceRef.current = price;

    const now = Date.now();
    const bucketStart = Math.floor(now / CANDLE_BUCKET_MS) * CANDLE_BUCKET_MS;
    const list = candlesRef.current;
    const last = list[list.length - 1];

    if (!last || last.t !== bucketStart) {
      const open = last ? last.close : price;
      const o = open;
      const c = price;
      const h = Math.max(o, c);
      const l = Math.min(o, c);
      const next: Candle = {
        t: bucketStart,
        open: o,
        high: h,
        low: l,
        close: c,
        range: [l, h],
        body: [Math.min(o, c), Math.max(o, c)],
      };
      candlesRef.current = [...list, next].slice(-CANDLE_COUNT);
    } else {
      const updated: Candle = {
        ...last,
        close: price,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
      };
      updated.range = [updated.low, updated.high];
      updated.body = [Math.min(updated.open, updated.close), Math.max(updated.open, updated.close)];
      candlesRef.current = [...list.slice(0, -1), updated];
    }
    setCandleData([...candlesRef.current]);
  }, [price]);

  useEffect(() => {
    let fallbackInterval: NodeJS.Timeout | null = null;
    let connected = false;

    const startFallback = () => {
      if (fallbackInterval) return;
      let base = 104000 + Math.random() * 2000;
      setPrice(base);
      fallbackInterval = setInterval(() => {
        const delta = (Math.random() - 0.48) * 80;
        base = Math.max(95000, base + delta);
        setPrice((prev) => {
          setPrevPrice(prev);
          const next = parseFloat(base.toFixed(2));
          if (next !== prev) setTickDir(next > prev ? "up" : "down");
          return next;
        });
      }, 800);
    };

    const connect = () => {
      const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");
      wsRef.current = ws;
      ws.onopen = () => {
        connected = true;
        if (fallbackInterval) {
          clearInterval(fallbackInterval);
          fallbackInterval = null;
        }
      };
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setPrice((prev) => {
          setPrevPrice(prev);
          const next = parseFloat(data.p);
          if (next !== prev) setTickDir(next > prev ? "up" : "down");
          return next;
        });
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        connected = false;
        if (wsRef.current === ws) {
          startFallback();
          setTimeout(connect, 5000);
        }
      };
    };

    const timer = setTimeout(() => {
      if (!connected) startFallback();
    }, 2000);
    connect();
    return () => {
      clearTimeout(timer);
      if (fallbackInterval) clearInterval(fallbackInterval);
      if (wsRef.current) wsRef.current.close();
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (resolveTimeoutRef.current) clearTimeout(resolveTimeoutRef.current);
    };
  }, []);

  const startCountdown = useCallback(
    (
      predId: number,
      direction: string,
      amount: number,
      entryPrice: number,
      duration: number,
      multiplier: number,
    ) => {
      setCountdown(duration);
      setActivePrediction({ id: predId, direction, amount, entryPrice, duration, multiplier });
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            countdownRef.current = null;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      countdownRef.current = interval;

      resolveTimeoutRef.current = setTimeout(async () => {
        const exitP = priceRef.current || entryPrice;
        try {
          const resolved = await resolvePrediction.mutateAsync({
            id: predId,
            data: { exitPrice: exitP },
          });
          const result: PriceResult = {
            direction,
            amount,
            entryPrice,
            exitPrice: exitP,
            won: resolved.status === "won",
            payout: resolved.payout ?? 0,
            id: predId,
          };

          if (result.won) {
            winStreakRef.current += 1;
            lossStreakRef.current = 0;
          } else {
            lossStreakRef.current += 1;
            winStreakRef.current = 0;
          }
          setWinStreak(winStreakRef.current);
          setLossStreak(lossStreakRef.current);

          const delta = Math.abs(exitP - entryPrice);
          if (delta < CLOSE_CALL_THRESHOLD && !result.won) {
            setShowCloseCall(true);
            setTimeout(() => setShowCloseCall(false), 4500);
          }

          setShowResult(result);
          setActivePrediction(null);
          queryClient.invalidateQueries({
            queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? ""),
          });
          queryClient.invalidateQueries({
            queryKey: getGetUserQueryKey(user?.telegramId ?? ""),
          });
          queryClient.invalidateQueries({
            queryKey: getGetVipActivityQueryKey(),
          });
        } catch {
          setActivePrediction(null);
        }
      }, duration * 1000);
    },
    [resolvePrediction, queryClient, user],
  );

  // Frontend reconciliation: on mount (and whenever recentPredictions arrives),
  // if any of the user's predictions is still pending and older than RECONCILE_AFTER_SEC,
  // immediately fire a /resolve so we never show a stale LIVE row.
  useEffect(() => {
    if (!user || !recentPredictions || reconcileRunRef.current) return;
    const now = Date.now();
    const stale = recentPredictions.filter((p) => {
      if (p.status !== "pending") return false;
      const dur = (p as { duration?: number }).duration ?? 60;
      const ageMs = now - new Date(p.createdAt).getTime();
      return ageMs > (dur + RECONCILE_GRACE_SEC) * 1000;
    });
    if (stale.length === 0) return;
    // Only reconcile when we actually have a live price. If we don't, leave
    // the rows for the backend sweeper — never resolve at entryPrice (that
    // would force a deterministic short-wins / long-loses outcome).
    if (!priceRef.current) return;
    reconcileRunRef.current = true;
    const livePrice = priceRef.current;
    (async () => {
      for (const p of stale) {
        try {
          await resolvePrediction.mutateAsync({
            id: p.id,
            data: { exitPrice: livePrice },
          });
        } catch {
          // ignore — backend sweeper will catch it
        }
      }
      queryClient.invalidateQueries({
        queryKey: getGetUserPredictionsQueryKey(user.telegramId),
      });
      queryClient.invalidateQueries({
        queryKey: getGetUserQueryKey(user.telegramId),
      });
    })();
    // `price` is in deps so we retry as soon as the first WS tick arrives.
  }, [user, recentPredictions, resolvePrediction, queryClient, price]);

  const selectedTier = DURATION_TIERS[tierIndex] ?? DURATION_TIERS[DEFAULT_TIER_INDEX];
  const vipBonus = user?.isVip ? VIP_MULTIPLIER_BONUS : 0;
  const activeMultiplier = +(selectedTier.baseMultiplier + vipBonus).toFixed(2);

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || activePrediction || bet < MIN_BET || bet > (user.tradeCredits ?? 0)) return;
    try {
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
      // Mark FOMO as shown once user places first trade of the day
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

  const vip = isVipActive(user);
  const priceUp = price > prevPrice;
  const priceColor = priceUp ? "#00f0ff" : "#ff2d78";
  const maxBet = vip ? 5000 : 1000;
  const betOptions = [50, 100, 250, 500, 1000];
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

  const showFomoBanner = !vip && !fomoShownToday && !tradedToday;

  // Animated payout counter for the WIN overlay (0 → final over ~600ms).
  const [animatedPayout, setAnimatedPayout] = useState(0);
  useEffect(() => {
    if (!showResult || !showResult.won) {
      setAnimatedPayout(0);
      return;
    }
    const target = showResult.payout;
    const start = performance.now();
    const duration = 600;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimatedPayout(Math.floor(target * eased));
      if (t < 1) raf = requestAnimationFrame(step);
      else setAnimatedPayout(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [showResult]);

  // Reset the micro tick-direction indicator shortly after each price update
  // so it flashes on every WS tick rather than sticking.
  useEffect(() => {
    if (!tickDir) return;
    const t = setTimeout(() => setTickDir(null), 350);
    return () => clearTimeout(t);
  }, [tickDir, price]);

  // Time-driven recompute: tick once per second so a row that's `pending`
  // but older than STALE_LIVE_SEC ages into the "auto" state without needing
  // a query refresh.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const hasPending = (recentPredictions ?? []).some(
      (p) => p.status === "pending",
    );
    if (!hasPending) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recentPredictions]);

  const decoratedRecent = useMemo(() => {
    return (recentPredictions ?? []).slice(0, 5).map((p) => {
      const ageSec = (nowTick - new Date(p.createdAt).getTime()) / 1000;
      const dur = (p as { duration?: number }).duration ?? 60;
      const stalePending = p.status === "pending" && ageSec > dur + STALE_LIVE_GRACE_SEC;
      const autoBadge =
        (p as { autoResolved?: boolean }).autoResolved === true || stalePending;
      return { p, stalePending, autoBadge };
    });
  }, [recentPredictions, nowTick]);

  const ringDuration = activePrediction?.duration ?? selectedTier.seconds;
  const ringProgress = ringDuration > 0 ? countdown / ringDuration : 0;
  const ringColor =
    ringProgress > 0.5 ? "#00f0ff" : ringProgress > 0.2 ? "#f5c518" : "#ff2d78";

  const isWinningNow =
    activePrediction &&
    price > 0 &&
    ((activePrediction.direction === "long" && price > activePrediction.entryPrice) ||
      (activePrediction.direction === "short" && price < activePrediction.entryPrice));

  return (
    <div className="flex flex-col min-h-screen bg-black pb-8">
      <style>{`
        @keyframes koinara-ticker {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes pulse-gold {
          0%, 100% { box-shadow: 0 0 20px rgba(245,197,24,0.4); }
          50% { box-shadow: 0 0 36px rgba(245,197,24,0.7); }
        }
        @keyframes flame-flicker {
          0%, 100% { transform: scaleY(1) rotate(-3deg); opacity: 1; }
          25% { transform: scaleY(1.15) rotate(2deg); opacity: 0.85; }
          50% { transform: scaleY(0.9) rotate(-2deg); opacity: 1; }
          75% { transform: scaleY(1.1) rotate(3deg); opacity: 0.9; }
        }
        .flame-icon {
          animation: flame-flicker 0.6s ease-in-out infinite;
          transform-origin: bottom center;
        }
      `}</style>

      {/* VIP Activity Ticker */}
      <VipTicker items={vipActivity} />

      {/* VIP Countdown / FOMO Banner */}
      {vip && user?.vipExpiresAt && (() => {
        const diff = new Date(user.vipExpiresAt).getTime() - Date.now();
        if (diff <= 0) return null;
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const label = d > 0 ? `${d}d ${h}h` : `${h}h`;
        return (
          <div className="mx-4 mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#f5c518]/30 bg-[#f5c518]/5">
            <Crown size={11} className="text-[#f5c518]" />
            <span className="font-mono text-[10px] text-[#f5c518]">VIP Active</span>
            <span className="font-mono text-[10px] text-white/40 ml-auto">{label} remaining</span>
          </div>
        );
      })()}

      {showFomoBanner && (
        <div
          className="mx-4 mt-2 px-3 py-2 rounded-lg border border-[#ff2d78]/25 bg-[#ff2d78]/5 cursor-pointer"
          onClick={() => {
            const today = new Date().toISOString().split("T")[0];
            try { localStorage.setItem("fomoShownDate", today); } catch {}
            setFomoShownToday(true);
            navigate("/wallet");
          }}
        >
          {yesterdayGc > 0 ? (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-[#ff2d78]">⚡ Yesterday:</span>
                <span className="font-mono text-[10px] text-white/60">
                  you earned <span className="text-[#f5c518] font-bold">{yesterdayGc.toLocaleString()} GC</span>
                </span>
              </div>
              <div className="font-mono text-[9px] text-[#ff2d78]/70">
                As VIP → <span className="font-bold">{yesterdayVipGc.toLocaleString()} GC</span> · missed{" "}
                <span className="text-[#ff2d78] font-bold">${yesterdayMissedUsd} USD</span> · Upgrade →
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-[#ff2d78]">⚡ VIP users earn 2× on every trade</span>
              <span className="font-mono text-[9px] text-white/30 ml-auto">Upgrade →</span>
            </div>
          )}
        </div>
      )}

      <div className="px-4 pt-3 flex flex-col gap-3">
        {/* Live Candlestick Chart */}
        {candleData.length > 1 && (
          <div
            className="rounded-xl overflow-hidden border border-white/5 bg-white/[0.01]"
            style={{ height: 110 }}
          >
            <ResponsiveContainer width="100%" height={110}>
              <BarChart
                data={candleData}
                margin={{ top: 8, right: 28, left: 8, bottom: 6 }}
                barCategoryGap={1}
              >
                <XAxis dataKey="t" hide />
                <YAxis
                  domain={["dataMin", "dataMax"]}
                  hide
                  allowDecimals
                />
                <Bar
                  dataKey="range"
                  shape={WickShape as never}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="body"
                  shape={BodyShape as never}
                  isAnimationActive={false}
                />
                {activePrediction && (
                  <ReferenceLine
                    y={activePrediction.entryPrice}
                    stroke="#f5c518"
                    strokeWidth={1.2}
                    strokeDasharray="4 3"
                    label={{
                      value: "ENTRY",
                      position: "right",
                      fill: "#f5c518",
                      fontSize: 9,
                      fontFamily: "monospace",
                    }}
                  />
                )}
                <ReferenceDot
                  x={candleData[candleData.length - 1]?.t ?? 0}
                  y={candleData[candleData.length - 1]?.close ?? 0}
                  r={3}
                  fill="#00f0ff"
                  stroke="rgba(0,240,255,0.45)"
                  strokeWidth={5}
                  isFront
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Live Price Display */}
        <div className="relative flex flex-col items-center justify-center py-4 border border-white/10 rounded-xl bg-white/[0.02] overflow-hidden">
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: `radial-gradient(circle at 50% 50%, ${priceColor}, transparent 70%)`,
            }}
          />
          <span className="font-mono text-[10px] text-white/40 tracking-widest mb-1">
            BTC/USDT LIVE
          </span>
          <motion.div
            key={Math.floor(price)}
            initial={{ scale: 1.04 }}
            animate={{ scale: 1 }}
            className="font-mono text-4xl font-black tracking-tight"
            style={{ color: priceColor, filter: `drop-shadow(0 0 14px ${priceColor})` }}
          >
            {price > 0
              ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
              : "CONNECTING..."}
          </motion.div>
          <AnimatePresence mode="wait">
            {tickDir && (
              <motion.div
                key={`tick-${price}`}
                initial={{ opacity: 0, y: tickDir === "up" ? 6 : -6, scale: 0.6 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: tickDir === "up" ? -8 : 8, scale: 0.6 }}
                transition={{ duration: 0.25 }}
                className="absolute -right-1 top-1/2 -translate-y-1/2"
                style={{
                  color: tickDir === "up" ? "#00f0ff" : "#ff2d78",
                  filter: `drop-shadow(0 0 8px ${tickDir === "up" ? "#00f0ff" : "#ff2d78"})`,
                }}
              >
                {tickDir === "up" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-2 mt-1">
            {priceUp ? (
              <TrendingUp size={12} className="text-[#00f0ff]" />
            ) : (
              <TrendingDown size={12} className="text-[#ff2d78]" />
            )}
            <span className="font-mono text-[10px]" style={{ color: priceColor }}>
              {priceUp ? "RISING" : "FALLING"}
            </span>
          </div>
        </div>

        {/* Active Trade Countdown */}
        {activePrediction && (
          <div className="flex flex-col items-center py-4 border border-white/10 rounded-xl bg-white/[0.02]">
            <div className="relative mb-3" style={{ width: 72, height: 72 }}>
              <svg className="w-full h-full -rotate-90" viewBox="0 0 72 72">
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="5"
                />
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="5"
                  strokeDasharray={`${2 * Math.PI * 30}`}
                  strokeDashoffset={`${2 * Math.PI * 30 * (1 - ringProgress)}`}
                  strokeLinecap="round"
                  style={{
                    transition: "stroke-dashoffset 1s linear, stroke 0.5s ease",
                  }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-2xl font-black text-white leading-none">
                  {countdown}
                </span>
                <span className="font-mono text-[8px] text-white/30">SEC</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="font-mono text-[9px] text-white/30 mb-0.5">DIRECTION</div>
                <span
                  className={`font-mono text-xs font-bold ${
                    activePrediction.direction === "long" ? "text-[#00f0ff]" : "text-[#ff2d78]"
                  }`}
                >
                  {activePrediction.direction.toUpperCase()}
                </span>
              </div>
              <div className="w-px h-6 bg-white/10" />
              <div className="text-center">
                <div className="font-mono text-[9px] text-white/30 mb-0.5">ENTRY</div>
                <span className="font-mono text-xs text-white/50">
                  ${activePrediction.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="w-px h-6 bg-white/10" />
              <div className="text-center">
                <div className="font-mono text-[9px] text-white/30 mb-0.5">NOW</div>
                <span className={`font-mono text-xs font-bold ${isWinningNow ? "text-[#00f0ff]" : "text-[#ff2d78]"}`}>
                  ${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </span>
              </div>
              <div className="w-px h-6 bg-white/10" />
              <div className="text-center">
                <div className="font-mono text-[9px] text-white/30 mb-0.5">LIVE P&L</div>
                <span
                  className={`font-mono text-sm font-bold ${
                    isWinningNow ? "text-[#00f0ff]" : "text-[#ff2d78]"
                  }`}
                >
                  {isWinningNow
                    ? `+${Math.floor(activePrediction.amount * activePrediction.multiplier)} GC`
                    : `-${activePrediction.amount} TC`}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Streak Badge */}
        <AnimatePresence>
          {winStreak >= 2 && !showResult && (
            <motion.div
              key="win-streak"
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.85, opacity: 0 }}
              className="flex items-center justify-center gap-2 py-2 px-4 rounded-xl border border-[#f5c518]/40 bg-[#f5c518]/10"
            >
              <Flame size={14} className="text-[#f5c518] flame-icon" />
              <span className="font-mono text-xs font-bold text-[#f5c518]">
                {winStreak} WIN STREAK — Keep Going!
              </span>
              <Flame size={14} className="text-[#f5c518] flame-icon" style={{ animationDelay: "0.3s" }} />
            </motion.div>
          )}
          {lossStreak >= 3 && !showResult && (
            <motion.div
              key="recovery"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="flex items-center gap-2 py-2 px-3 rounded-xl border border-[#ff2d78]/30"
              style={{ background: "rgba(255,45,120,0.06)" }}
            >
              <span className="font-mono text-[10px] text-[#ff2d78]">
                ⚠ RECOVERY MODE — Lower your bet and rebuild your TC
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Close Call Toast */}
        <AnimatePresence>
          {showCloseCall && (
            <motion.div
              key="close-call"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-center gap-2 py-2 px-3 rounded-xl border border-[#f5c518]/40"
              style={{ background: "rgba(245,197,24,0.07)" }}
            >
              <Zap size={12} className="text-[#f5c518] shrink-0" />
              <span className="font-mono text-[10px] text-[#f5c518]">
                CLOSE CALL — You almost won, price barely moved against you!
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Active Powerup Badges */}
        {activeGems && activeGems.filter(g => g.usesRemaining > 0).length > 0 && !activePrediction && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {hasBigSwing && (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full border border-[#f5c518]/50 bg-[#f5c518]/10">
                <Gem size={9} className="text-[#f5c518]" />
                <span className="font-mono text-[9px] text-[#f5c518] font-bold">5× BIG SWING</span>
              </div>
            )}
            {!hasBigSwing && hasStarterBoost && (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full border border-[#00f0ff]/50 bg-[#00f0ff]/10">
                <Zap size={9} className="text-[#00f0ff]" />
                <span className="font-mono text-[9px] text-[#00f0ff] font-bold">2× BOOST</span>
              </div>
            )}
            {hasStreakSaver && (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full border border-[#ff2d78]/50 bg-[#ff2d78]/10">
                <Shield size={9} className="text-[#ff2d78]" />
                <span className="font-mono text-[9px] text-[#ff2d78] font-bold">STREAK SAVER</span>
              </div>
            )}
          </div>
        )}

        {/* Time-Limit (Round Duration) Selector */}
        {!activePrediction && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">
                Round Length
              </span>
              <span className="font-mono text-[10px] text-[#f5c518]">
                {activeMultiplier.toFixed(1)}× payout
                {vip && <span className="text-[#f5c518]/70 ml-1">(+VIP)</span>}
              </span>
            </div>
            <div className="flex gap-1.5">
              {DURATION_TIERS.map((tier, i) => {
                const mult = +(tier.baseMultiplier + (vip ? VIP_MULTIPLIER_BONUS : 0)).toFixed(2);
                const selected = i === tierIndex;
                return (
                  <button
                    key={tier.seconds}
                    onClick={() => setTierIndex(i)}
                    className={`relative flex-1 py-2 rounded font-mono font-bold border transition-all duration-150 ${
                      selected
                        ? "border-[#f5c518] text-[#f5c518] bg-[#f5c518]/10"
                        : "border-white/10 text-white/40 hover:border-white/30"
                    }`}
                    style={
                      selected
                        ? {
                            boxShadow:
                              "0 0 14px rgba(245,197,24,0.45), inset 0 0 10px rgba(245,197,24,0.08)",
                          }
                        : undefined
                    }
                  >
                    <div className="text-[11px] leading-tight">{tier.label}</div>
                    <div className={`text-[9px] leading-tight ${selected ? "text-[#f5c518]/90" : "text-white/30"}`}>
                      {mult.toFixed(1)}×
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Bet Amount Selector */}
        {!activePrediction && (
          <>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">
                  Bet Amount
                </span>
                <span className="font-mono text-xs text-[#00f0ff]">{bet} 🔵 TC</span>
              </div>
              <div className="flex gap-1.5">
                {betOptions
                  .filter((o) => o <= maxBet)
                  .map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setBet(opt)}
                      className={`flex-1 py-2 rounded font-mono text-xs font-bold border transition-all duration-150 ${
                        bet === opt
                          ? "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/10"
                          : "border-white/10 text-white/40 hover:border-white/30"
                      }`}
                    >
                      {opt >= 1000 ? `${opt / 1000}K` : opt}
                    </button>
                  ))}
                {vip && (
                  <button
                    onClick={() => setBet(5000)}
                    className={`flex-1 py-2 rounded font-mono text-xs font-bold border transition-all duration-150 ${
                      bet === 5000
                        ? "border-[#f5c518] text-[#f5c518] bg-[#f5c518]/10"
                        : "border-[#f5c518]/30 text-[#f5c518]/50 hover:border-[#f5c518]/60"
                    }`}
                  >
                    5K
                  </button>
                )}
              </div>
            </div>

            <input
              type="number"
              value={bet}
              min={MIN_BET}
              max={maxBet}
              onChange={(e) =>
                setBet(Math.max(MIN_BET, Math.min(maxBet, parseInt(e.target.value) || MIN_BET)))
              }
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 font-mono text-sm text-white focus:border-[#00f0ff] focus:outline-none"
              placeholder="Custom amount (TC)"
            />

            <div className="flex items-center justify-between px-3 py-2 rounded border border-[#f5c518]/15 bg-[#f5c518]/5">
              <span className="font-mono text-[10px] text-white/40">WIN REWARD</span>
              {vip ? (
                <span className="font-mono text-xs font-bold flex items-baseline gap-1">
                  <span className="text-white/40">+{expectedGc}</span>
                  <span className="text-[#f5c518]/60">→</span>
                  <span className="text-[#f5c518]">+{vipGc} 🪙 GC</span>
                  <span className="text-white/35 text-[10px]">≈ {formatGcUsd(vipGc)}</span>
                  <span className="text-[#f5c518]/60 ml-0.5">👑 VIP</span>
                </span>
              ) : (
                <span className="font-mono text-xs font-bold text-white/60 flex items-baseline gap-1">
                  <span className="text-[#f5c518]">+{expectedGc} GC</span>
                  <span className="text-white/35 text-[10px]">≈ {formatGcUsd(expectedGc)}</span>
                  <span className="text-[#f5c518]/50">(VIP: {vipGc} GC 👑)</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => handlePredict("long")}
                disabled={!user || !price || bet < MIN_BET || bet > (user?.tradeCredits ?? 0)}
                className="relative flex flex-col items-center py-5 rounded-xl border-2 border-[#00f0ff] bg-[#00f0ff]/10 font-mono font-black text-[#00f0ff] text-lg disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ boxShadow: "0 0 20px rgba(0,240,255,0.3)" }}
              >
                <TrendingUp size={24} className="mb-1" />
                LONG
                <span className="text-[10px] font-normal text-white/40 mt-1">Price Goes Up</span>
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => handlePredict("short")}
                disabled={!user || !price || bet < MIN_BET || bet > (user?.tradeCredits ?? 0)}
                className="relative flex flex-col items-center py-5 rounded-xl border-2 border-[#ff2d78] bg-[#ff2d78]/10 font-mono font-black text-[#ff2d78] text-lg disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ boxShadow: "0 0 20px rgba(255,45,120,0.3)" }}
              >
                <TrendingDown size={24} className="mb-1" />
                SHORT
                <span className="text-[10px] font-normal text-white/40 mt-1">Price Goes Down</span>
              </motion.button>
            </div>

            <div className="flex items-center justify-center gap-2">
              <Clock size={10} className="text-white/30" />
              <span className="font-mono text-[9px] text-white/30 tracking-wider">
                {selectedTier.label.toUpperCase()} ROUND · WIN {Math.round(activeMultiplier * 100)}% AS 🪙 GOLD COINS
                {vip && <span className="text-[#f5c518]/70 ml-1">· 👑 VIP +{VIP_MULTIPLIER_BONUS.toFixed(1)}×</span>}
              </span>
            </div>
          </>
        )}

        {/* Recent Rounds History */}
        <div>
          <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">
            Recent Rounds
          </span>
        </div>
        <div className="space-y-2 pb-4">
          {decoratedRecent.map(({ p: pred, stalePending, autoBadge }) => (
            <div
              key={pred.id}
              className={`flex items-center justify-between px-3 py-2 rounded border ${
                pred.status === "won"
                  ? "border-[#00f0ff]/30 bg-[#00f0ff]/5"
                  : pred.status === "lost"
                    ? "border-[#ff2d78]/30 bg-[#ff2d78]/5"
                    : "border-white/10 bg-white/5"
              }`}
            >
              <div className="flex items-center gap-2">
                {pred.direction === "long" ? (
                  <TrendingUp size={12} className="text-[#00f0ff]" />
                ) : (
                  <TrendingDown size={12} className="text-[#ff2d78]" />
                )}
                <span className="font-mono text-xs text-white/60 uppercase">
                  {pred.direction}
                </span>
                {autoBadge && pred.status !== "pending" && (
                  <span
                    title="Auto-resolved by server"
                    className="inline-flex items-center gap-0.5 font-mono text-[8px] text-white/35 px-1 py-0.5 rounded border border-white/10 bg-white/5"
                  >
                    <Clock size={8} /> auto
                  </span>
                )}
              </div>
              <div className="font-mono text-xs text-white/40 flex items-center gap-1">
                {pred.amount} TC
              </div>
              <div
                className={`font-mono text-xs font-bold flex items-center gap-1 ${
                  pred.status === "won"
                    ? "text-[#f5c518]"
                    : pred.status === "lost"
                      ? "text-[#ff2d78]"
                      : stalePending
                        ? "text-white/30"
                        : "text-white/40"
                }`}
              >
                {pred.status === "won" ? (
                  <>
                    <span>+{pred.payout} 🪙</span>
                    <span className="text-white/30 text-[9px] font-normal">
                      ≈ {formatGcUsd(pred.payout ?? 0)}
                    </span>
                  </>
                ) : pred.status === "lost" ? (
                  `-${pred.amount} TC`
                ) : stalePending ? (
                  <span title="Server is finalizing this round">· auto</span>
                ) : (
                  "LIVE"
                )}
              </div>
            </div>
          ))}
          {!recentPredictions?.length && (
            <div className="flex flex-col items-center py-8 text-white/20">
              <Zap size={24} className="mb-2" />
              <span className="font-mono text-xs">No trades yet. Make your first call.</span>
            </div>
          )}
        </div>
      </div>

      {/* Win/Loss Result Overlay — full-screen */}
      <AnimatePresence>
        {showResult && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center px-6"
            style={{ background: "rgba(0,0,0,0.88)" }}
          >
            <motion.div
              initial={{ scale: 0.88, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.88, y: -24 }}
              className="relative w-full max-w-xs rounded-2xl border-2 overflow-hidden"
              style={{
                borderColor: showResult.won ? "#00f0ff" : "#ff2d78",
                background: showResult.won
                  ? "rgba(0,240,255,0.07)"
                  : "rgba(255,45,120,0.07)",
                boxShadow: showResult.won
                  ? "0 0 60px rgba(0,240,255,0.35)"
                  : "0 0 60px rgba(255,45,120,0.35)",
              }}
            >
              <button
                onClick={() => setShowResult(null)}
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full bg-white/10 text-white/50 font-mono text-base hover:bg-white/20 z-10"
              >
                ×
              </button>

              <div className="p-6 text-center">
                <div
                  className="font-mono text-5xl font-black mb-2"
                  style={{ color: showResult.won ? "#00f0ff" : "#ff2d78" }}
                >
                  {showResult.won ? "WIN" : "LOSS"}
                </div>
                {showResult.won ? (
                  <>
                    <motion.div
                      key={showResult.id}
                      animate={{ filter: ["blur(0px)", "blur(0.6px)", "blur(0px)"] }}
                      transition={{ duration: 0.35, times: [0, 0.5, 1] }}
                      className="font-mono text-2xl font-bold text-[#f5c518]"
                    >
                      +{animatedPayout.toLocaleString()} 🪙 GC
                    </motion.div>
                    <div className="font-mono text-[10px] text-white/40 mt-1">
                      ≈ {formatGcUsd(showResult.payout)} · Gold Coins added to balance
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-mono text-sm text-white/50 mt-1">
                      -{showResult.amount} TC lost
                    </div>
                    {/* Double or Nothing button — appears on loss */}
                    {donPredictionId !== showResult.id && (
                      <motion.button
                        whileTap={{ scale: 0.97 }}
                        onClick={async () => {
                          if (!user || !price || showResult.amount * 2 > (user.tradeCredits ?? 0)) return;
                          setDonPredictionId(showResult.id);
                          setShowResult(null);
                          try {
                            const pred = await createPrediction.mutateAsync({
                              data: {
                                telegramId: user.telegramId,
                                direction: showResult.direction as "long" | "short",
                                amount: showResult.amount * 2,
                                entryPrice: price,
                                duration: selectedTier.seconds,
                                multiplier: activeMultiplier,
                              },
                            });
                            queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
                            startCountdown(
                              pred.id,
                              showResult.direction,
                              showResult.amount * 2,
                              price,
                              selectedTier.seconds,
                              activeMultiplier,
                            );
                          } catch {
                            setDonPredictionId(null);
                          }
                        }}
                        disabled={!user || showResult.amount * 2 > (user?.tradeCredits ?? 0)}
                        className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono text-xs font-black border-2 border-[#ff2d78] text-[#ff2d78] bg-[#ff2d78]/10 disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ boxShadow: "0 0 15px rgba(255,45,120,0.2)" }}
                      >
                        <RotateCcw size={12} />
                        DOUBLE OR NOTHING — {(showResult.amount * 2).toLocaleString()} TC
                      </motion.button>
                    )}
                    {showResult.amount * 2 > (user?.tradeCredits ?? 0) && (
                      <div className="font-mono text-[9px] text-white/25 mt-1 text-center">Not enough TC to double</div>
                    )}
                  </>
                )}
                <div className="font-mono text-[10px] text-white/30 mt-2">
                  {showResult.direction.toUpperCase()} · Exit $
                  {showResult.exitPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              </div>

              {/* FOMO section for free users — per-trade 2x comparison */}
              {!vip && (
                <div
                  className="border-t border-[#f5c518]/20 px-5 py-4"
                  style={{ background: "rgba(245,197,24,0.06)" }}
                >
                  <div className="font-mono text-[9px] text-[#f5c518]/60 tracking-widest mb-1.5">
                    VIP ADVANTAGE
                  </div>
                  <div className="font-mono text-xs text-white/65 leading-relaxed mb-3">
                    {showResult.won ? (
                      <>
                        As a VIP you would have earned{" "}
                        <span className="text-[#f5c518] font-bold">
                          {(showResult.payout * 2).toLocaleString()} GC
                        </span>{" "}
                        on this trade instead of{" "}
                        <span className="text-white/40">
                          {showResult.payout.toLocaleString()} GC
                        </span>
                        . Upgrade and double every win!
                      </>
                    ) : (
                      <>
                        As a VIP, a winning trade here pays{" "}
                        <span className="text-[#f5c518] font-bold">
                          {Math.floor(showResult.amount * activeMultiplier * 2).toLocaleString()} GC
                        </span>{" "}
                        vs{" "}
                        <span className="text-white/40">
                          {Math.floor(showResult.amount * activeMultiplier).toLocaleString()} GC
                        </span>{" "}
                        free — upgrade to unlock 2× rewards!
                      </>
                    )}
                  </div>
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      setShowResult(null);
                      navigate("/profile");
                    }}
                    className="w-full py-2.5 rounded-lg font-mono text-xs font-bold text-black"
                    style={{
                      background: "linear-gradient(135deg, #f5c518, #e0a800)",
                      animation: "pulse-gold 2s ease-in-out infinite",
                    }}
                  >
                    <Crown size={11} className="inline mr-1.5 mb-0.5" />
                    UPGRADE TO VIP — DOUBLE YOUR REWARDS
                  </motion.button>
                </div>
              )}

              {/* VIP crown acknowledgement */}
              {vip && (
                <div
                  className="border-t border-[#f5c518]/20 px-5 py-3 flex items-center gap-2"
                  style={{ background: "rgba(245,197,24,0.05)" }}
                >
                  <Crown size={13} className="text-[#f5c518]" />
                  <span className="font-mono text-[10px] text-[#f5c518]">
                    Congratulations! VIP 2× payout active — up to 6,000 GC/day
                  </span>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, Crown, Flame } from "lucide-react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ReferenceDot,
  ResponsiveContainer,
} from "recharts";
import {
  useCreatePrediction,
  useResolvePrediction,
  useGetUserPredictions,
  useGetVipActivity,
  getGetUserPredictionsQueryKey,
  getGetUserQueryKey,
  getGetVipActivityQueryKey,
} from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

const ROUND_DURATION = 60;
const GC_RATIO = 0.85;
const MIN_BET = 50;
const DEFAULT_BET = 100;
const CLOSE_CALL_THRESHOLD = 15;
const CHART_TICKS = 60;

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

interface PriceTick {
  p: number;
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
              withdrew {item.payout} GC
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
  const [priceHistory, setPriceHistory] = useState<PriceTick[]>([]);
  const [bet, setBet] = useState(DEFAULT_BET);
  const [activePrediction, setActivePrediction] = useState<{
    id: number;
    direction: string;
    amount: number;
    entryPrice: number;
  } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [showResult, setShowResult] = useState<PriceResult | null>(null);
  const [winStreak, setWinStreak] = useState(0);
  const [lossStreak, setLossStreak] = useState(0);
  const [showCloseCall, setShowCloseCall] = useState(false);

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

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const { data: recentPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { limit: 5 },
    { query: { enabled: !!user, queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") } },
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
    if (price > 0) {
      priceRef.current = price;
      setPriceHistory((prev) => {
        const next = [...prev, { p: price }];
        return next.slice(-CHART_TICKS);
      });
    }
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
          return parseFloat(base.toFixed(2));
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
          return parseFloat(data.p);
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
    (predId: number, direction: string, amount: number, entryPrice: number) => {
      setCountdown(ROUND_DURATION);
      setActivePrediction({ id: predId, direction, amount, entryPrice });
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
      }, ROUND_DURATION * 1000);
    },
    [resolvePrediction, queryClient, user],
  );

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || activePrediction || bet < MIN_BET || bet > (user.tradeCredits ?? 0)) return;
    try {
      const pred = await createPrediction.mutateAsync({
        data: { telegramId: user.telegramId, direction, amount: bet, entryPrice: price },
      });
      startCountdown(pred.id, direction, bet, price);
    } catch {}
  };

  const vip = isVipActive(user);
  const priceUp = price > prevPrice;
  const priceColor = priceUp ? "#00f0ff" : "#ff2d78";
  const maxBet = vip ? 5000 : 1000;
  const betOptions = [50, 100, 250, 500, 1000];
  const expectedGc = Math.floor(bet * GC_RATIO);
  const vipGc = expectedGc * 2;

  const ringProgress = countdown / ROUND_DURATION;
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

      <div className="px-4 pt-3 flex flex-col gap-3">
        {/* Live Price Chart */}
        {priceHistory.length > 1 && (
          <div
            className="rounded-xl overflow-hidden border border-white/5 bg-white/[0.01]"
            style={{ height: 88 }}
          >
            <ResponsiveContainer width="100%" height={88}>
              <ComposedChart data={priceHistory} margin={{ top: 6, right: 8, left: 8, bottom: 6 }}>
                <defs>
                  <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00f0ff" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#00f0ff" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis hide />
                <YAxis domain={["dataMin", "dataMax"]} hide />
                <Area
                  type="monotone"
                  dataKey="p"
                  stroke="none"
                  fill="url(#chartGrad)"
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="p"
                  stroke="#00f0ff"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  style={{ filter: "drop-shadow(0 0 3px #00f0ff)" }}
                />
                <ReferenceDot
                  x={priceHistory.length - 1}
                  y={priceHistory[priceHistory.length - 1]?.p ?? 0}
                  r={4}
                  fill="#00f0ff"
                  stroke="rgba(0,240,255,0.45)"
                  strokeWidth={6}
                  isFront
                />
              </ComposedChart>
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
                    ? `+${Math.floor(activePrediction.amount * GC_RATIO)} GC`
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
                <span className="font-mono text-xs font-bold">
                  <span className="text-[#f5c518]">+{vipGc} 🪙 GC</span>
                  <span className="text-[#f5c518]/60 ml-1.5">👑 VIP rate</span>
                </span>
              ) : (
                <span className="font-mono text-xs font-bold text-white/60">
                  <span className="text-[#f5c518]">+{expectedGc} GC</span>
                  <span className="text-[#f5c518]/50 ml-1.5">(VIP: {vipGc} GC 👑)</span>
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
                60 SECOND ROUND · WIN {GC_RATIO * 100}% AS 🪙 GOLD COINS
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
          {(recentPredictions ?? []).slice(0, 5).map((pred) => (
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
              </div>
              <div className="font-mono text-xs text-white/40">{pred.amount} TC</div>
              <div
                className={`font-mono text-xs font-bold ${
                  pred.status === "won"
                    ? "text-[#f5c518]"
                    : pred.status === "lost"
                      ? "text-[#ff2d78]"
                      : "text-white/40"
                }`}
              >
                {pred.status === "won"
                  ? `+${pred.payout} 🪙`
                  : pred.status === "lost"
                    ? `-${pred.amount} TC`
                    : "LIVE"}
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
                    <div className="font-mono text-2xl font-bold text-[#f5c518]">
                      +{showResult.payout.toLocaleString()} 🪙 GC
                    </div>
                    <div className="font-mono text-[10px] text-white/40 mt-1">
                      Gold Coins added to balance
                    </div>
                  </>
                ) : (
                  <div className="font-mono text-sm text-white/50 mt-1">
                    -{showResult.amount} TC lost
                  </div>
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
                          {Math.floor(showResult.amount * GC_RATIO * 2).toLocaleString()} GC
                        </span>{" "}
                        vs{" "}
                        <span className="text-white/40">
                          {Math.floor(showResult.amount * GC_RATIO).toLocaleString()} GC
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
                    VIP active — up to 3,000 GC/day
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

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, AlertCircle } from "lucide-react";
import { useCreatePrediction, useResolvePrediction, useGetUserPredictions, getGetUserPredictionsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

const ROUND_DURATION = 6;
const PAYOUT_MULTIPLIER = 1.7;
const MIN_BET = 10;
const DEFAULT_BET = 50;

interface PriceResult {
  direction: string;
  amount: number;
  entryPrice: number;
  exitPrice: number;
  won: boolean;
  payout: number;
  id: number;
}

export default function Terminal() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const [price, setPrice] = useState<number>(0);
  const [prevPrice, setPrevPrice] = useState<number>(0);
  const [bet, setBet] = useState(DEFAULT_BET);
  const [activePrediction, setActivePrediction] = useState<{
    id: number;
    direction: string;
    amount: number;
    entryPrice: number;
  } | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [results, setResults] = useState<PriceResult[]>([]);
  const [showResult, setShowResult] = useState<PriceResult | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();

  const { data: recentPredictions } = useGetUserPredictions(
    user?.telegramId ?? "",
    { query: { limit: 5, enabled: !!user, queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") } }
  );

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
        setPrice(prev => {
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
        const newPrice = parseFloat(data.p);
        setPrice(prev => {
          setPrevPrice(prev);
          return newPrice;
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
    };
  }, []);

  const startCountdown = useCallback((predId: number, direction: string, amount: number, entryPrice: number) => {
    setCountdown(ROUND_DURATION);
    setActivePrediction({ id: predId, direction, amount, entryPrice });
    const interval = setInterval(async () => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          countdownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    countdownRef.current = interval;

    setTimeout(async () => {
      const exitP = price || entryPrice;
      try {
        const resolved = await resolvePrediction.mutateAsync({ id: predId, data: { exitPrice: exitP } });
        const result: PriceResult = {
          direction,
          amount,
          entryPrice,
          exitPrice: exitP,
          won: resolved.status === "won",
          payout: resolved.payout ?? 0,
          id: predId,
        };
        setResults(prev => [result, ...prev].slice(0, 5));
        setShowResult(result);
        setActivePrediction(null);
        setTimeout(() => setShowResult(null), 3000);
        queryClient.invalidateQueries({ queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") });
      } catch {
        setActivePrediction(null);
      }
    }, ROUND_DURATION * 1000);
  }, [price, resolvePrediction, queryClient, user]);

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || activePrediction || bet < MIN_BET || bet > (user.points ?? 0)) return;
    try {
      const pred = await createPrediction.mutateAsync({
        data: { telegramId: user.telegramId, direction, amount: bet, entryPrice: price }
      });
      startCountdown(pred.id, direction, bet, price);
    } catch {}
  };

  const priceUp = price > prevPrice;
  const priceColor = priceUp ? "#00f0ff" : "#ff2d78";
  const priceGlow = priceUp
    ? "drop-shadow-[0_0_20px_#00f0ff]"
    : "drop-shadow-[0_0_20px_#ff2d78]";

  const betOptions = [10, 25, 50, 100, 250];

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-[#00f0ff] drop-shadow-[0_0_6px_#00f0ff]" />
          <span className="font-mono text-xs text-white/60 tracking-widest uppercase">BTC/USDT Terminal</span>
        </div>
        {user && (
          <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded px-2 py-1">
            <Zap size={12} className="text-[#00f0ff]" />
            <span className="font-mono text-xs text-white font-bold">{(user.points ?? 0).toLocaleString()}</span>
            <span className="font-mono text-[10px] text-white/40">AP</span>
          </div>
        )}
      </div>

      {/* Live Price Display */}
      <div className="relative flex flex-col items-center justify-center py-8 mb-4 border border-white/10 rounded-xl bg-white/[0.02] overflow-hidden">
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: `radial-gradient(circle at 50% 50%, ${priceColor}, transparent 70%)`
        }} />
        <span className="font-mono text-[10px] text-white/40 tracking-widest mb-2">LIVE PRICE</span>
        <motion.div
          key={Math.floor(price)}
          initial={{ scale: 1.05 }}
          animate={{ scale: 1 }}
          className={`font-mono text-5xl font-black tracking-tight ${priceGlow}`}
          style={{ color: priceColor }}
        >
          {price > 0 ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : "CONNECTING..."}
        </motion.div>
        <div className="flex items-center gap-2 mt-2">
          {priceUp ? (
            <TrendingUp size={14} className="text-[#00f0ff]" />
          ) : (
            <TrendingDown size={14} className="text-[#ff2d78]" />
          )}
          <span className="font-mono text-xs" style={{ color: priceColor }}>
            {priceUp ? "RISING" : "FALLING"}
          </span>
        </div>
      </div>

      {/* Countdown Ring */}
      {activePrediction && (
        <div className="flex flex-col items-center mb-4 py-4 border border-white/10 rounded-xl bg-white/[0.02]">
          <div className="relative w-16 h-16 mb-2">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
              <circle
                cx="32" cy="32" r="28" fill="none"
                stroke={activePrediction.direction === "long" ? "#00f0ff" : "#ff2d78"}
                strokeWidth="4"
                strokeDasharray={`${2 * Math.PI * 28}`}
                strokeDashoffset={`${2 * Math.PI * 28 * (1 - countdown / ROUND_DURATION)}`}
                strokeLinecap="round"
                style={{ transition: "stroke-dashoffset 1s linear" }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-mono text-xl font-black text-white">{countdown}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Clock size={12} className="text-white/40" />
            <span className="font-mono text-xs text-white/60">
              {activePrediction.direction.toUpperCase()} — {activePrediction.amount} AP @ ${activePrediction.entryPrice.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {/* Win/Loss Result Overlay */}
      <AnimatePresence>
        {showResult && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -20 }}
            className={`fixed inset-0 z-50 flex items-center justify-center pointer-events-none`}
          >
            <div
              className={`relative px-10 py-8 rounded-2xl border-2 text-center`}
              style={{
                borderColor: showResult.won ? "#00f0ff" : "#ff2d78",
                background: showResult.won ? "rgba(0,240,255,0.15)" : "rgba(255,45,120,0.15)",
                boxShadow: showResult.won
                  ? "0 0 60px rgba(0,240,255,0.5), 0 0 120px rgba(0,240,255,0.2)"
                  : "0 0 60px rgba(255,45,120,0.5), 0 0 120px rgba(255,45,120,0.2)",
              }}
            >
              <div className="font-mono text-5xl font-black mb-2" style={{ color: showResult.won ? "#00f0ff" : "#ff2d78" }}>
                {showResult.won ? "WIN" : "LOSS"}
              </div>
              {showResult.won && (
                <div className="font-mono text-2xl text-white font-bold">
                  +{showResult.payout.toLocaleString()} AP
                </div>
              )}
              <div className="font-mono text-xs text-white/50 mt-1">
                {showResult.direction.toUpperCase()} @ ${showResult.exitPrice.toFixed(2)}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bet Amount Selector */}
      {!activePrediction && (
        <>
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">Bet Amount</span>
              <span className="font-mono text-xs text-[#00f0ff]">{bet} Alpha Points</span>
            </div>
            <div className="flex gap-2">
              {betOptions.map(opt => (
                <button
                  key={opt}
                  onClick={() => setBet(opt)}
                  className={`flex-1 py-2 rounded font-mono text-xs font-bold border transition-all duration-150 ${
                    bet === opt
                      ? "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/10"
                      : "border-white/10 text-white/40 hover:border-white/30"
                  }`}
                  data-testid={`btn-bet-${opt}`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>

          {/* Custom bet input */}
          <div className="mb-4">
            <input
              type="number"
              value={bet}
              min={MIN_BET}
              max={user?.points ?? 9999}
              onChange={e => setBet(Math.max(MIN_BET, parseInt(e.target.value) || MIN_BET))}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 font-mono text-sm text-white focus:border-[#00f0ff] focus:outline-none"
              placeholder="Custom amount"
              data-testid="input-bet-custom"
            />
          </div>

          {/* Predict Buttons */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => handlePredict("long")}
              disabled={!user || !price || bet < MIN_BET || bet > (user?.points ?? 0)}
              className="relative flex flex-col items-center py-5 rounded-xl border-2 border-[#00f0ff] bg-[#00f0ff]/10 font-mono font-black text-[#00f0ff] text-lg disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ boxShadow: "0 0 20px rgba(0,240,255,0.3)" }}
              data-testid="btn-predict-long"
            >
              <TrendingUp size={24} className="mb-1" />
              LONG
              <span className="text-[10px] font-normal text-white/40 mt-1">Price Goes Up</span>
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => handlePredict("short")}
              disabled={!user || !price || bet < MIN_BET || bet > (user?.points ?? 0)}
              className="relative flex flex-col items-center py-5 rounded-xl border-2 border-[#ff2d78] bg-[#ff2d78]/10 font-mono font-black text-[#ff2d78] text-lg disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ boxShadow: "0 0 20px rgba(255,45,120,0.3)" }}
              data-testid="btn-predict-short"
            >
              <TrendingDown size={24} className="mb-1" />
              SHORT
              <span className="text-[10px] font-normal text-white/40 mt-1">Price Goes Down</span>
            </motion.button>
          </div>

          <div className="flex items-center justify-center gap-2 mb-6">
            <AlertCircle size={10} className="text-white/30" />
            <span className="font-mono text-[9px] text-white/30 tracking-wider">WIN {PAYOUT_MULTIPLIER}x YOUR BET — 6 SECOND ROUND</span>
          </div>
        </>
      )}

      {/* Recent Predictions History */}
      <div className="mb-2">
        <span className="font-mono text-[10px] text-white/40 tracking-widest uppercase">Recent Rounds</span>
      </div>
      <div className="space-y-2">
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
              <span className="font-mono text-xs text-white/60 uppercase">{pred.direction}</span>
            </div>
            <div className="font-mono text-xs text-white/40">{pred.amount} AP</div>
            <div className={`font-mono text-xs font-bold ${
              pred.status === "won" ? "text-[#00f0ff]" : pred.status === "lost" ? "text-[#ff2d78]" : "text-white/40"
            }`}>
              {pred.status === "won" ? `+${pred.payout}` : pred.status === "lost" ? `-${pred.amount}` : "LIVE"}
            </div>
          </div>
        ))}
        {!recentPredictions?.length && (
          <div className="flex flex-col items-center py-8 text-white/20">
            <Zap size={24} className="mb-2" />
            <span className="font-mono text-xs">No predictions yet. Make your first call.</span>
          </div>
        )}
      </div>
    </div>
  );
}

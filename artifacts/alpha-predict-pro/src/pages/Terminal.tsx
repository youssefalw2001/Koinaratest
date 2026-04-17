import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrendingUp, TrendingDown, Zap, Clock, AlertCircle } from "lucide-react";
import { useCreatePrediction, useResolvePrediction, useGetUserPredictions, getGetUserPredictionsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

const ROUND_DURATION = 60;
const GC_RATIO = 0.85;
const MIN_BET = 50;
const DEFAULT_BET = 100;

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
    { limit: 5 },
    { query: { enabled: !!user, queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") } }
  );

  // Binance WS with fallback price simulation
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
        if (fallbackInterval) { clearInterval(fallbackInterval); fallbackInterval = null; }
      };
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        setPrice(prev => { setPrevPrice(prev); return parseFloat(data.p); });
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        connected = false;
        if (wsRef.current === ws) { startFallback(); setTimeout(connect, 5000); }
      };
    };

    const timer = setTimeout(() => { if (!connected) startFallback(); }, 2000);
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
    const interval = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) { clearInterval(interval); countdownRef.current = null; return 0; }
        return prev - 1;
      });
    }, 1000);
    countdownRef.current = interval;

    setTimeout(async () => {
      const exitP = price || entryPrice;
      try {
        const resolved = await resolvePrediction.mutateAsync({ id: predId, data: { exitPrice: exitP } });
        const result: PriceResult = {
          direction, amount, entryPrice,
          exitPrice: exitP,
          won: resolved.status === "won",
          payout: resolved.payout ?? 0,
          id: predId,
        };
        setResults(prev => [result, ...prev].slice(0, 5));
        setShowResult(result);
        setActivePrediction(null);
        setTimeout(() => setShowResult(null), 4000);
        queryClient.invalidateQueries({ queryKey: getGetUserPredictionsQueryKey(user?.telegramId ?? "") });
        queryClient.invalidateQueries({ queryKey: ["getUser", user?.telegramId] });
      } catch { setActivePrediction(null); }
    }, ROUND_DURATION * 1000);
  }, [price, resolvePrediction, queryClient, user]);

  const handlePredict = async (direction: "long" | "short") => {
    if (!user || activePrediction || bet < MIN_BET || bet > (user.tradeCredits ?? 0)) return;
    try {
      const pred = await createPrediction.mutateAsync({
        data: { telegramId: user.telegramId, direction, amount: bet, entryPrice: price }
      });
      startCountdown(pred.id, direction, bet, price);
    } catch {}
  };

  const priceUp = price > prevPrice;
  const priceColor = priceUp ? "#00f0ff" : "#ff2d78";
  const maxBet = user?.isVip ? 5000 : 1000;
  const betOptions = [50, 100, 250, 500, 1000];
  const expectedGc = Math.floor(bet * GC_RATIO); // payout is always bet × 0.85; VIP advantage is daily cap only

  const ringProgress = countdown / ROUND_DURATION;
  const ringColor = ringProgress > 0.5 ? "#00f0ff" : ringProgress > 0.2 ? "#f5c518" : "#ff2d78";

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      {/* Live Price Display */}
      <div className="relative flex flex-col items-center justify-center py-8 mb-4 border border-white/10 rounded-xl bg-white/[0.02] overflow-hidden">
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: `radial-gradient(circle at 50% 50%, ${priceColor}, transparent 70%)`
        }} />
        <span className="font-mono text-[10px] text-white/40 tracking-widest mb-2">BTC/USDT LIVE</span>
        <motion.div
          key={Math.floor(price)}
          initial={{ scale: 1.04 }}
          animate={{ scale: 1 }}
          className="font-mono text-5xl font-black tracking-tight"
          style={{ color: priceColor, filter: `drop-shadow(0 0 20px ${priceColor})` }}
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

      {/* Active Trade Countdown */}
      {activePrediction && (
        <div className="flex flex-col items-center mb-4 py-4 border border-white/10 rounded-xl bg-white/[0.02]">
          <div className="relative w-20 h-20 mb-3">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
              <circle
                cx="40" cy="40" r="34" fill="none"
                stroke={ringColor}
                strokeWidth="5"
                strokeDasharray={`${2 * Math.PI * 34}`}
                strokeDashoffset={`${2 * Math.PI * 34 * (1 - ringProgress)}`}
                strokeLinecap="round"
                style={{ transition: "stroke-dashoffset 1s linear, stroke 0.5s ease" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-2xl font-black text-white leading-none">{countdown}</span>
              <span className="font-mono text-[9px] text-white/30">SEC</span>
            </div>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`font-mono text-xs font-bold ${activePrediction.direction === "long" ? "text-[#00f0ff]" : "text-[#ff2d78]"}`}>
              {activePrediction.direction.toUpperCase()}
            </span>
            <span className="font-mono text-[10px] text-white/40">—</span>
            <span className="font-mono text-xs text-white/60">{activePrediction.amount} TC</span>
          </div>
          <div className="font-mono text-[10px] text-white/30">
            ENTRY: ${activePrediction.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </div>
          {price > 0 && (
            <div className={`font-mono text-sm font-bold mt-1 ${
              ((activePrediction.direction === "long" && price > activePrediction.entryPrice) ||
               (activePrediction.direction === "short" && price < activePrediction.entryPrice))
                ? "text-[#00f0ff]" : "text-[#ff2d78]"
            }`}>
              {((activePrediction.direction === "long" && price > activePrediction.entryPrice) ||
                (activePrediction.direction === "short" && price < activePrediction.entryPrice))
                ? `+${Math.floor(activePrediction.amount * GC_RATIO)} GC`
                : `-${activePrediction.amount} TC`
              }
            </div>
          )}
        </div>
      )}

      {/* Win/Loss Result Overlay */}
      <AnimatePresence>
        {showResult && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -20 }}
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
          >
            <div
              className="relative px-10 py-8 rounded-2xl border-2 text-center"
              style={{
                borderColor: showResult.won ? "#00f0ff" : "#ff2d78",
                background: showResult.won ? "rgba(0,240,255,0.12)" : "rgba(255,45,120,0.12)",
                boxShadow: showResult.won
                  ? "0 0 60px rgba(0,240,255,0.5), 0 0 120px rgba(0,240,255,0.2)"
                  : "0 0 60px rgba(255,45,120,0.5), 0 0 120px rgba(255,45,120,0.2)",
              }}
            >
              <div className="font-mono text-5xl font-black mb-2" style={{ color: showResult.won ? "#00f0ff" : "#ff2d78" }}>
                {showResult.won ? "WIN" : "LOSS"}
              </div>
              {showResult.won ? (
                <>
                  <div className="font-mono text-2xl font-bold" style={{ color: "#f5c518" }}>
                    +{showResult.payout.toLocaleString()} 🪙 GC
                  </div>
                  <div className="font-mono text-[10px] text-white/40 mt-1">Gold Coins added to balance</div>
                </>
              ) : (
                <div className="font-mono text-sm text-white/50 mt-1">
                  -{showResult.amount} TC lost
                </div>
              )}
              <div className="font-mono text-xs text-white/30 mt-2">
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
              <span className="font-mono text-xs text-[#00f0ff]">{bet} 🔵 TC</span>
            </div>
            <div className="flex gap-1.5">
              {betOptions.filter(o => o <= maxBet).map(opt => (
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
            </div>
          </div>

          <div className="mb-3">
            <input
              type="number"
              value={bet}
              min={MIN_BET}
              max={maxBet}
              onChange={e => setBet(Math.max(MIN_BET, Math.min(maxBet, parseInt(e.target.value) || MIN_BET)))}
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 font-mono text-sm text-white focus:border-[#00f0ff] focus:outline-none"
              placeholder="Custom amount (TC)"
            />
          </div>

          {/* Expected payout */}
          <div className="flex items-center justify-between mb-3 px-3 py-2 rounded bg-[#f5c518]/5 border border-[#f5c518]/15">
            <span className="font-mono text-[10px] text-white/40">WIN REWARD</span>
            <span className="font-mono text-sm font-bold text-[#f5c518]">
              +{expectedGc} 🪙 GC
            </span>
          </div>

          {/* Predict Buttons */}
          <div className="grid grid-cols-2 gap-3 mb-4">
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

          <div className="flex items-center justify-center gap-2 mb-5">
            <Clock size={10} className="text-white/30" />
            <span className="font-mono text-[9px] text-white/30 tracking-wider">
              60 SECOND ROUND · WIN {GC_RATIO * (user?.isVip ? 2 : 1) * 100}% AS 🪙 GOLD COINS
            </span>
          </div>
        </>
      )}

      {/* Recent Rounds History */}
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
            <div className="font-mono text-xs text-white/40">{pred.amount} TC</div>
            <div className={`font-mono text-xs font-bold ${
              pred.status === "won" ? "text-[#f5c518]" : pred.status === "lost" ? "text-[#ff2d78]" : "text-white/40"
            }`}>
              {pred.status === "won" ? `+${pred.payout} 🪙` : pred.status === "lost" ? `-${pred.amount} TC` : "LIVE"}
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
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTelegram } from "@/lib/TelegramProvider";

/* ═════════════════════════════════════ CONSTANTS ═════════════════════════════════════ */
const BTC_WS = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const BTC_REST = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
const BET_AMOUNTS = [50, 100, 250, 500, 1000];
const POWER_UPS = [
  { id: "hotStreak", label: "Hot Streak", multiplier: 3, uses: 5 },
  { id: "doubleDown", label: "Double Down", multiplier: 2, uses: 1 },
  { id: "starterBoost", label: "Starter Boost", multiplier: 2, uses: 3 },
  { id: "bigSwing", label: "Big Swing", multiplier: 5, uses: 2 },
  { id: "streakSaver", label: "Streak Saver", refund: true, uses: 1 },
];
const CHART_UPDATE_MS = 500;

/* ═════════════════════════════════════ TYPES ═════════════════════════════════════ */
interface PowerUpState {
  id: string;
  active: boolean;
  remaining: number;
}

/* ═════════════════════════════════════ MAIN COMPONENT ═════════════════════════════════════ */
export default function Terminal() {
  const [btcPrice, setBtcPrice] = useState<number>(0);
  const [betAmount, setBetAmount] = useState<number>(50);
  const [powerUps, setPowerUps] = useState<PowerUpState[]>(
    POWER_UPS.map(p => ({ id: p.id, active: false, remaining: p.uses }))
  );
  const [vip, setVip] = useState<boolean>(false); // placeholder for VIP logic
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  const chartDataRef = useRef<number[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const fallbackIntervalRef = useRef<number | null>(null);

  /* ═════════════════════════════════════ BTC PRICE FEED ═════════════════════════════════════ */
  const connectWS = useCallback(() => {
    wsRef.current = new WebSocket(BTC_WS);
    wsRef.current.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      setBtcPrice(parseFloat(data.p));
    };
    wsRef.current.onclose = () => {
      fallbackIntervalRef.current = window.setInterval(async () => {
        try {
          const resp = await fetch(BTC_REST);
          const json = await resp.json();
          setBtcPrice(parseFloat(json.price));
        } catch {}
      }, 2000);
    };
  }, []);

  useEffect(() => {
    connectWS();
    return () => {
      wsRef.current?.close();
      if (fallbackIntervalRef.current) clearInterval(fallbackIntervalRef.current);
    };
  }, [connectWS]);

  /* ═════════════════════════════════════ CHART LOGIC ═════════════════════════════════════ */
  useEffect(() => {
    const canvas = chartRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrame: number;
    const render = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,0,0.9)";
      ctx.shadowBlur = 10;
      ctx.shadowColor = "gold";
      ctx.beginPath();
      const data = chartDataRef.current;
      const h = canvas.height;
      const w = canvas.width;
      const max = Math.max(...data, btcPrice || 0) || 1;
      const min = Math.min(...data, btcPrice || 0);
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - ((v - min) / (max - min)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // gradient fill
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "rgba(255,215,0,0.2)");
      gradient.addColorStop(1, "rgba(255,215,0,0)");
      ctx.fillStyle = gradient;
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  // update chart data
  useEffect(() => {
    const interval = setInterval(() => {
      chartDataRef.current.push(btcPrice);
      if (chartDataRef.current.length > 60) chartDataRef.current.shift();
    }, CHART_UPDATE_MS);
    return () => clearInterval(interval);
  }, [btcPrice]);

  /* ═════════════════════════════════════ MULTIPLIER VISUALS ═════════════════════════════════════ */
  const getPayout = (amount: number) => {
    let base = amount * 1.5; // placeholder base multiplier
    if (vip) base *= 2;
    return Math.floor(base);
  };

  /* ═════════════════════════════════════ POWER-UPS LOGIC ═════════════════════════════════════ */
  const togglePowerUp = (id: string) => {
    setPowerUps((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, active: !p.active } : p
      )
    );
  };

  /* ═════════════════════════════════════ RENDER ═════════════════════════════════════ */
  return (
    <div className="terminal-page p-4">
      <h2 className="text-white text-xl mb-2">BTC Price: {btcPrice.toFixed(2)} USDT</h2>
      <canvas ref={chartRef} width={600} height={200} className="w-full rounded-lg bg-black" />

      <div className="mt-4 flex gap-2">
        {BET_AMOUNTS.map((amt) => (
          <div key={amt} className="relative cursor-pointer" onClick={() => setBetAmount(amt)}>
            <button
              className={`px-4 py-2 rounded-full border ${betAmount === amt ? "border-yellow-400" : "border-gray-500"}`}
            >
              {amt} GC
            </button>
            <div className="absolute -bottom-5 w-full text-center text-xs text-yellow-300">
              +{getPayout(amt)} GC
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <AnimatePresence>
          {powerUps.map((p) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="inline-block mr-2 px-3 py-1 rounded-full text-xs font-bold"
              style={{
                backgroundColor: p.active ? "gold" : "gray",
                boxShadow: p.active ? "0 0 8px gold" : "none",
              }}
              onClick={() => togglePowerUp(p.id)}
            >
              {p.active ? "ACTIVE " : ""}
              {POWER_UPS.find(u => u.id === p.id)?.label}
            </motion.div>
          ))}
          {powerUps.every(p => !p.active) && <span className="text-gray-400">No active power-ups</span>}
        </AnimatePresence>
      </div>

      <div className="mt-4">
        <h3 className="text-white text-lg">Selected Bet:</h3>
        <motion.div
          key={betAmount}
          className="text-yellow-400 text-2xl font-bold"
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 1] }}
          transition={{ duration: 0.5 }}
        >
          Win → +{getPayout(betAmount)} GC {vip ? "👑" : ""}
        </motion.div>
      </div>
    </div>
  );
}

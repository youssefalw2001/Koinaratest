import { useState, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bomb, Gem, Zap, Info, Shield, Trophy, RotateCcw, ChevronRight, Lock } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader } from "@/components/PageStatus";
import confetti from "canvas-confetti";

const API_BASE = "/api/mines";
const HOUSE_EDGE_MULT = 0.965; // Matches backend 3.5% edge

interface ActiveRound {
  roundId: number;
  gridSize: number;
  minesCount: number;
  bet: number;
  revealed: number[];
  multiplier: number;
  serverSeedHash: string;
  clientSeed: string;
}

interface MinesResult {
  hit: boolean;
  revealed: number[];
  multiplier: number;
  status: "active" | "won" | "bust";
  mines?: number[];
  payout?: number;
}

export default function Mines() {
  const { user, isLoading: userLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [gridSize, setGridSize] = useState(5);
  const [minesCount, setMinesCount] = useState(3);
  const [bet, setBet] = useState(100);
  const [activeRound, setActiveRound] = useState<ActiveRound | null>(null);
  const [lastResult, setLastResult] = useState<MinesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [clientSeed, setClientSeed] = useState(() => Math.random().toString(36).substring(7));

  const vip = isVipActive(user);
  const maxBet = vip ? 10000 : 2000;

  const fetchActive = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/active/${user.telegramId}`, {
        headers: { 
          "x-telegram-init-data": (window as any).Telegram.WebApp.initData || ""
        },
      });
      const data = await res.json();
      if (data.active) {
        setActiveRound(data.active);
        setGridSize(data.active.gridSize);
        setMinesCount(data.active.minesCount);
        setBet(data.active.bet);
      }
    } catch {}
  }, [user]);

  useEffect(() => {
    fetchActive();
  }, [fetchActive]);

  const handleStart = async () => {
    if (!user || loading) return;
    setLoading(true);
    setLastResult(null);
    try {
      const res = await fetch(`${API_BASE}/start`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-telegram-init-data": (window as any).Telegram.WebApp.initData || ""
        },
        body: JSON.stringify({ telegramId: user.telegramId, gridSize, minesCount, bet, clientSeed }),
      });
      const data = await res.json();
      if (res.ok) {
        setActiveRound(data);
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      }
    } catch {}
    setLoading(false);
  };

  const handleReveal = async (tile: number) => {
    if (!activeRound || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reveal`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-telegram-init-data": (window as any).Telegram.WebApp.initData || ""
        },
        body: JSON.stringify({ telegramId: user!.telegramId, roundId: activeRound.roundId, tile }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.status === "bust") {
          setLastResult({ ...data, hit: true });
          setActiveRound(null);
          refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
        } else {
          setActiveRound({ ...activeRound, revealed: data.revealed, multiplier: data.multiplier });
        }
      }
    } catch {}
    setLoading(false);
  };

  const handleCashout = async () => {
    if (!activeRound || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/cashout`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "x-telegram-init-data": (window as any).Telegram.WebApp.initData || ""
        },
        body: JSON.stringify({ telegramId: user!.telegramId, roundId: activeRound.roundId }),
      });
      const data = await res.json();
      if (res.ok) {
        setLastResult({ ...data, hit: false });
        setActiveRound(null);
        confetti({ 
          particleCount: 150, 
          spread: 70, 
          origin: { y: 0.6 }, 
          colors: ["#FFD700", "#FFF9E0", "#B8860B"] 
        });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
      }
    } catch {}
    setLoading(false);
  };

  const nextMultiplier = useMemo(() => {
    if (!activeRound) return 0;
    const total = activeRound.gridSize * activeRound.gridSize;
    const safeTiles = total - activeRound.minesCount;
    const revealedCount = activeRound.revealed.length + 1;
    if (revealedCount > safeTiles) return activeRound.multiplier;
    let mult = 1;
    for (let i = 0; i < revealedCount; i++) {
      mult *= (total - i) / (safeTiles - i);
    }
    return +(HOUSE_EDGE_MULT * mult).toFixed(4);
  }, [activeRound]);

  if (userLoading) return <PageLoader rows={6} />;

  return (
    <div className="flex flex-col min-h-screen p-4 pb-24 bg-[#050508]">
      <style>{`
        @keyframes pulse-tension {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.02); filter: brightness(1.2) drop-shadow(0 0 15px rgba(255,215,0,0.3)); }
        }
        .tension-active {
          animation: pulse-tension 1.5s ease-in-out infinite;
        }
        .grid-glow {
          box-shadow: 0 0 40px rgba(255, 215, 0, 0.05);
        }
        .gold-text-gradient {
          background: linear-gradient(135deg, #FFD700 0%, #B8860B 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }
      `}</style>

      {/* Header Stats */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex flex-col">
          <span className="text-[10px] font-mono text-white/30 tracking-[0.2em] uppercase">Mines Terminal</span>
          <h1 className="text-xl font-black gold-text-gradient tracking-tight">PROVABLY FAIR</h1>
        </div>
        {activeRound && (
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-mono text-[#FFD700] font-bold">{activeRound.multiplier.toFixed(2)}x</span>
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-tighter">Current Multiplier</span>
          </div>
        )}
      </div>

      {/* Main Game Grid */}
      <div className={`aspect-square w-full grid gap-2 p-3 rounded-3xl border border-white/[0.05] bg-white/[0.02] grid-glow mb-6 ${activeRound ? "tension-active" : ""}`}
           style={{ gridTemplateColumns: `repeat(${activeRound?.gridSize ?? gridSize}, 1fr)` }}>
        {Array.from({ length: (activeRound?.gridSize ?? gridSize) ** 2 }).map((_, i) => {
          const isRevealed = activeRound?.revealed.includes(i);
          const isMine = lastResult?.mines?.includes(i);
          const isLastClicked = lastResult?.revealed?.slice(-1)[0] === i;
          const isGhostMine = !activeRound && lastResult?.mines?.includes(i) && !isLastClicked;

          return (
            <motion.button
              key={i}
              whileTap={!activeRound || isRevealed ? {} : { scale: 0.9 }}
              onClick={() => !isRevealed && handleReveal(i)}
              disabled={!activeRound || isRevealed}
              className={`relative rounded-xl flex items-center justify-center transition-all duration-300 overflow-hidden ${
                isRevealed ? "bg-[#FFD700]/10 border-[#FFD700]/30" : 
                isMine ? "bg-[#FF1744]/20 border-[#FF1744]/50" :
                isGhostMine ? "bg-white/[0.05] border-white/[0.1] opacity-40" :
                "bg-white/[0.05] border-white/[0.1] hover:bg-white/[0.08]"
              } border`}
            >
              {isRevealed && <Gem size={20} className="text-[#FFD700] drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]" />}
              {isMine && <Bomb size={20} className={isLastClicked ? "text-[#FF1744]" : "text-white/40"} />}
              {isGhostMine && <Bomb size={14} className="text-white/20" />}
              
              {activeRound && !isRevealed && (
                <div className="absolute inset-0 bg-gradient-to-tr from-white/[0.02] to-transparent" />
              )}
            </motion.button>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-4">
        {!activeRound ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-white/30 ml-1 uppercase">Grid Size</span>
                <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.05]">
                  {[3, 4, 5].map(s => (
                    <button key={s} onClick={() => setGridSize(s as any)} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${gridSize === s ? "bg-[#FFD700] text-black" : "text-white/40"}`}>{s}x{s}</button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-white/30 ml-1 uppercase">Mines</span>
                <input type="number" value={minesCount} onChange={e => setMinesCount(Math.max(1, parseInt(e.target.value) || 1))} className="bg-white/[0.03] border border-white/[0.05] rounded-xl py-2 px-3 text-xs font-bold text-[#FFD700] outline-none" />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-mono text-white/30 ml-1 uppercase">Bet Amount (TC)</span>
              <div className="flex gap-2">
                {[100, 250, 500, 1000].map(v => (
                  <button key={v} onClick={() => setBet(v)} className={`flex-1 py-2 rounded-xl border text-[10px] font-bold transition-all ${bet === v ? "border-[#4DA3FF] bg-[#4DA3FF]/10 text-[#8BC3FF]" : "border-white/10 text-white/30"}`}>{v}</button>
                ))}
              </div>
            </div>

            <button onClick={handleStart} disabled={loading || (user?.tradeCredits ?? 0) < bet} className="w-full py-4 rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#B8860B] text-black font-black text-sm tracking-widest shadow-[0_0_30px_rgba(255,215,0,0.2)] disabled:opacity-30 uppercase">Start Round</button>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between p-4 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/5">
              <div className="flex flex-col">
                <span className="text-[10px] font-mono text-white/40 uppercase">Next Tile Reward</span>
                <span className="text-lg font-black text-[#FFD700]">{nextMultiplier.toFixed(2)}x</span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-mono text-white/40 uppercase">Current Cashout</span>
                <span className="text-lg font-black text-white">{(activeRound.bet * activeRound.multiplier).toFixed(0)} TC</span>
              </div>
            </div>
            <button onClick={handleCashout} disabled={activeRound.revealed.length === 0 || loading} className="w-full py-4 rounded-2xl bg-white text-black font-black text-sm tracking-widest uppercase disabled:opacity-30">Cash Out</button>
          </div>
        )}

        {/* Last Result Toast */}
        <AnimatePresence>
          {lastResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`p-4 rounded-2xl border flex items-center justify-between ${lastResult.hit ? "border-[#FF1744]/30 bg-[#FF1744]/5" : "border-[#FFD700]/30 bg-[#FFD700]/5"}`}>
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${lastResult.hit ? "bg-[#FF1744]/20" : "bg-[#FFD700]/20"}`}>
                  {lastResult.hit ? <Bomb size={16} className="text-[#FF1744]" /> : <Trophy size={16} className="text-[#FFD700]" />}
                </div>
                <div className="flex flex-col">
                  <span className="text-xs font-black text-white uppercase">{lastResult.hit ? "Boom! Hit a Mine" : "Round Won!"}</span>
                  <span className="text-[10px] font-mono text-white/40">{lastResult.hit ? "Try again for the rush" : `You won ${lastResult.payout} TC`}</span>
                </div>
              </div>
              {!lastResult.hit && <span className="text-sm font-black text-[#FFD700]">{lastResult.multiplier.toFixed(2)}x</span>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

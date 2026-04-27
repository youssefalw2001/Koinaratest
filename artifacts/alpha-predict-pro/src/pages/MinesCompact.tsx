import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bomb,
  ChevronDown,
  ChevronUp,
  Coins,
  Crown,
  Gem,
  Lock,
  Shield,
  Sparkles,
  Star,
  Trophy,
  Zap,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader } from "@/components/PageStatus";
import confetti from "canvas-confetti";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const HOUSE_EDGE_MULT = 0.945;

type GameMode = "tc" | "gc";
type GcTierId = "bronze" | "silver" | "gold";

type ActiveRound = {
  roundId: number;
  gridSize: number;
  minesCount: number;
  bet: number;
  mode: GameMode;
  tier: GcTierId | null;
  revealed: number[];
  multiplier: number;
};

type RoundResult = {
  won: boolean;
  payout?: number;
  mines?: number[];
  hitTile?: number;
  multiplier?: number;
  mode?: GameMode;
  tier?: GcTierId | null;
};

type PassesData = {
  passes: Record<string, number>;
  dailyGcFromMines: number;
  dailyGcCap: number;
  dailyGcRemaining: number;
};

const GC_TIER_CONFIG: Record<GcTierId, {
  label: string;
  currency: "gc" | "tc";
  minBet: number;
  maxBet: number;
  entryFeeTon: string;
  color: string;
  icon: typeof Crown;
  desc: string;
}> = {
  bronze: { label: "Bronze", currency: "gc", minBet: 500, maxBet: 3000, entryFeeTon: "0.05", color: "#CD7F32", icon: Coins, desc: "Bet GC → Win GC" },
  silver: { label: "Silver", currency: "gc", minBet: 1000, maxBet: 8000, entryFeeTon: "0.10", color: "#C0C0C0", icon: Star, desc: "Bet GC → Win GC" },
  gold: { label: "Gold", currency: "tc", minBet: 500, maxBet: 5000, entryFeeTon: "0.25", color: "#FFD700", icon: Crown, desc: "Bet TC → Win GC" },
};

function computeNextMultiplier(gridSize: number, minesCount: number, revealedAfter: number): number {
  const total = gridSize * gridSize;
  const safeTiles = total - minesCount;
  if (revealedAfter <= 0) return 1;
  if (revealedAfter > safeTiles) return 0;
  let mult = 1;
  for (let i = 0; i < revealedAfter; i += 1) {
    mult *= (total - i) / (safeTiles - i);
  }
  return +(HOUSE_EDGE_MULT * mult).toFixed(4);
}

function Tile({
  index,
  revealed,
  mine,
  disabled,
  onClick,
  accent,
}: {
  index: number;
  revealed: boolean;
  mine: boolean;
  disabled: boolean;
  onClick: () => void;
  accent: string;
}) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.14, delay: index * 0.004 }}
      whileTap={disabled || revealed ? {} : { scale: 0.9 }}
      disabled={disabled || revealed}
      onClick={onClick}
      className="relative aspect-square rounded-2xl border border-white/[0.075] bg-white/[0.045] flex items-center justify-center overflow-hidden"
      style={revealed ? { borderColor: mine ? "rgba(255,23,68,0.42)" : `${accent}66`, background: mine ? "rgba(255,23,68,0.12)" : `${accent}12` } : undefined}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.055] to-transparent" />
      {revealed && !mine && <Gem size={18} style={{ color: accent, filter: `drop-shadow(0 0 10px ${accent})` }} />}
      {revealed && mine && <Bomb size={18} className="text-[#FF1744] drop-shadow-[0_0_10px_rgba(255,23,68,0.8)]" />}
    </motion.button>
  );
}

export default function MinesCompact() {
  const { user, isLoading: userLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const initData = useRef((window as any)?.Telegram?.WebApp?.initData || "").current;

  const [mode, setMode] = useState<GameMode>("tc");
  const [selectedTier, setSelectedTier] = useState<GcTierId>("bronze");
  const [gridSize, setGridSize] = useState<3 | 4 | 5>(5);
  const [minesCount, setMinesCount] = useState(3);
  const [bet, setBet] = useState(100);
  const [clientSeed] = useState(() => Math.random().toString(36).slice(2));
  const [activeRound, setActiveRound] = useState<ActiveRound | null>(null);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [loadingTile, setLoadingTile] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  const [passesData, setPassesData] = useState<PassesData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vip = isVipActive(user);
  const tier = GC_TIER_CONFIG[selectedTier];
  const accent = mode === "gc" ? tier.color : "#FFD700";
  const maxBet = mode === "gc" ? tier.maxBet : (vip ? 8000 : 2000);
  const minBet = mode === "gc" ? tier.minBet : 50;
  const currency = mode === "gc" ? tier.currency.toUpperCase() : "TC";
  const balance = mode === "gc" && tier.currency === "gc" ? (user?.goldCoins ?? 0) : (user?.tradeCredits ?? 0);
  const passesForTier = passesData?.passes?.[selectedTier] ?? 0;
  const dailyGcFromMines = passesData?.dailyGcFromMines ?? 0;
  const dailyGcCap = passesData?.dailyGcCap ?? 5000;
  const capProgress = Math.min(100, dailyGcCap > 0 ? (dailyGcFromMines / dailyGcCap) * 100 : 0);

  const currentGridSize = activeRound?.gridSize ?? gridSize;
  const totalTiles = currentGridSize * currentGridSize;
  const revealed = activeRound?.revealed ?? [];
  const cashoutValue = activeRound ? Math.floor(activeRound.bet * activeRound.multiplier) : 0;
  const nextMultiplier = useMemo(() => {
    if (activeRound) return computeNextMultiplier(activeRound.gridSize, activeRound.minesCount, activeRound.revealed.length + 1);
    return computeNextMultiplier(gridSize, minesCount, 1);
  }, [activeRound, gridSize, minesCount]);
  const canStart = !starting && !activeRound && balance >= bet && (mode === "tc" || passesForTier > 0);
  const canCashout = !!activeRound && activeRound.revealed.length > 0 && !cashingOut;

  const fetchPasses = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/mines/passes/${user.telegramId}`, { headers: { "x-telegram-init-data": initData } });
      if (!res.ok) return;
      setPassesData(await res.json());
    } catch {
      // silent
    }
  }, [initData, user]);

  const fetchActive = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/mines/active/${user.telegramId}`, { headers: { "x-telegram-init-data": initData } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.active) return;
      setActiveRound({
        roundId: data.active.roundId,
        gridSize: data.active.gridSize,
        minesCount: data.active.minesCount,
        bet: data.active.bet,
        mode: data.active.mode ?? "tc",
        tier: data.active.tier ?? null,
        revealed: data.active.revealed ?? [],
        multiplier: data.active.multiplier ?? 1,
      });
      setMode(data.active.mode ?? "tc");
      if (data.active.tier) setSelectedTier(data.active.tier);
      setGridSize(data.active.gridSize);
      setMinesCount(data.active.minesCount);
      setBet(data.active.bet);
    } catch {
      // silent
    }
  }, [initData, user]);

  useEffect(() => {
    fetchActive();
    fetchPasses();
  }, [fetchActive, fetchPasses]);

  useEffect(() => {
    if (!activeRound) setBet(minBet);
  }, [activeRound, minBet, mode, selectedTier]);

  const startRound = async () => {
    if (!user || !canStart) return;
    setStarting(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { telegramId: user.telegramId, gridSize, minesCount, bet, clientSeed, mode };
      if (mode === "gc") body.tier = selectedTier;
      const res = await fetch(`${API_BASE}/mines/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not start round.");
      setActiveRound({ roundId: data.roundId, gridSize: data.gridSize, minesCount: data.minesCount, bet: data.bet, mode: data.mode ?? mode, tier: data.tier ?? null, revealed: data.revealed ?? [], multiplier: data.multiplier ?? 1 });
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      fetchPasses();
    } catch (e: any) {
      setError(e?.message || "Could not start round.");
    } finally {
      setStarting(false);
    }
  };

  const revealTile = async (tile: number) => {
    if (!user || !activeRound || loadingTile !== null || activeRound.revealed.includes(tile)) return;
    setLoadingTile(tile);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/mines/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ telegramId: user.telegramId, roundId: activeRound.roundId, tile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not reveal tile.");
      if (data.hit) {
        setResult({ won: false, mines: data.mines, hitTile: tile, mode: activeRound.mode, tier: activeRound.tier });
        setActiveRound(null);
        await refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      } else {
        const newRevealed = data.revealed ?? [...activeRound.revealed, tile];
        setActiveRound((prev) => prev ? { ...prev, revealed: newRevealed, multiplier: data.multiplier ?? computeNextMultiplier(prev.gridSize, prev.minesCount, newRevealed.length) } : null);
      }
    } catch (e: any) {
      setError(e?.message || "Could not reveal tile.");
    } finally {
      setLoadingTile(null);
    }
  };

  const cashout = async () => {
    if (!user || !activeRound || !canCashout) return;
    setCashingOut(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/mines/cashout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ telegramId: user.telegramId, roundId: activeRound.roundId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not cash out.");
      setResult({ won: true, payout: data.payout ?? cashoutValue, multiplier: activeRound.multiplier, mines: data.mines, mode: activeRound.mode, tier: activeRound.tier });
      setActiveRound(null);
      confetti({ particleCount: 120, spread: 65, origin: { y: 0.55 }, colors: [accent, "#FFF9E0", "#FFD700"] });
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      fetchPasses();
    } catch (e: any) {
      setError(e?.message || "Could not cash out.");
    } finally {
      setCashingOut(false);
    }
  };

  if (userLoading) return <PageLoader rows={6} />;

  const roundAccent = activeRound?.tier ? GC_TIER_CONFIG[activeRound.tier].color : accent;
  const roundCurrency = activeRound ? (activeRound.mode === "gc" && activeRound.tier !== "gold" ? "GC" : "TC") : currency;

  return (
    <div className="min-h-screen bg-[#050508] px-4 pt-4 pb-28 text-white">
      <style>{`
        .mines-glass { background: linear-gradient(160deg, rgba(21, 17, 9, 0.82), rgba(7, 8, 13, 0.94)); border: 1px solid rgba(255, 215, 0, 0.16); box-shadow: 0 14px 36px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.055); backdrop-filter: blur(18px); }
        .mines-blue { background: linear-gradient(160deg, rgba(13, 24, 44, 0.78), rgba(7, 8, 13, 0.94)); border: 1px solid rgba(77, 163, 255, 0.18); }
      `}</style>

      <section className="flex items-end justify-between mb-3">
        <div>
          <p className="font-mono text-[9px] tracking-[0.28em] uppercase text-white/28">Mines Terminal</p>
          <h1 className="text-2xl font-black tracking-tight text-[#FFD700]">{activeRound ? "ROUND LIVE" : mode === "gc" ? `${tier.label} Mode` : "Classic Mode"}</h1>
        </div>
        <div className="text-right">
          <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/35">Next tile</p>
          <p className="text-2xl font-black" style={{ color: roundAccent }}>{nextMultiplier.toFixed(2)}x</p>
        </div>
      </section>

      <section className="mines-glass rounded-2xl p-3 mb-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-[#FFD700]" />
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#FFE266]">Daily Mines Limit</span>
          </div>
          <span className="font-mono text-[10px] text-white/65">{dailyGcFromMines.toLocaleString()} / {dailyGcCap.toLocaleString()} GC</span>
        </div>
        <div className="h-2 rounded-full bg-white/8 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#FFB800] to-[#00F5A0]" style={{ width: `${capProgress}%` }} />
        </div>
      </section>

      {!activeRound && (
        <section className="space-y-3 mb-3">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setMode("tc")} className={`rounded-2xl py-3 font-black text-sm border ${mode === "tc" ? "bg-[#FFD700] text-black border-[#FFD700]" : "bg-white/[0.035] text-white/40 border-white/10"}`}>Classic TC</button>
            <button onClick={() => setMode("gc")} className={`rounded-2xl py-3 font-black text-sm border ${mode === "gc" ? "bg-gradient-to-r from-[#CD7F32] via-[#C0C0C0] to-[#FFD700] text-black border-[#FFD700]/40" : "bg-white/[0.035] text-white/40 border-white/10"}`}>GC Mines</button>
          </div>

          {mode === "gc" && (
            <div className="grid grid-cols-3 gap-2">
              {(["bronze", "silver", "gold"] as GcTierId[]).map((tierId) => {
                const config = GC_TIER_CONFIG[tierId];
                const Icon = config.icon;
                const selected = selectedTier === tierId;
                return (
                  <button key={tierId} onClick={() => setSelectedTier(tierId)} className="rounded-2xl border p-3 text-center" style={{ borderColor: selected ? `${config.color}88` : "rgba(255,255,255,0.08)", background: selected ? `${config.color}14` : "rgba(255,255,255,0.025)" }}>
                    <Icon size={16} className="mx-auto mb-1" style={{ color: selected ? config.color : "rgba(255,255,255,0.32)" }} />
                    <div className="text-xs font-black" style={{ color: selected ? config.color : "rgba(255,255,255,0.45)" }}>{config.label}</div>
                    <div className="font-mono text-[8px] text-white/32 mt-0.5">{config.entryFeeTon} TON</div>
                    <div className="font-mono text-[8px] text-white/22">{config.desc}</div>
                  </button>
                );
              })}
            </div>
          )}

          {mode === "gc" && (
            <div className="mines-glass rounded-2xl p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-black text-white">Round Passes</div>
                  <div className="font-mono text-[10px] text-white/35">Available: {passesForTier}</div>
                </div>
                <Lock size={18} style={{ color: accent }} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 5, 10].map((size) => (
                  <button key={size} className="rounded-2xl border border-white/10 bg-white/[0.035] py-2.5 text-center">
                    <div className="font-black text-white">{size}x</div>
                    <div className="font-mono text-[10px]" style={{ color: accent }}>{size === 1 ? tier.entryFeeTon : size === 5 ? Number(tier.entryFeeTon) * 3.9 : Number(tier.entryFeeTon) * 6.9} TON</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {!activeRound && (
        <section className="mines-blue rounded-3xl p-3 mb-3">
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <p className="font-mono text-[9px] tracking-[0.16em] uppercase text-white/35 mb-1">Grid</p>
              <div className="grid grid-cols-3 gap-1.5">
                {[3, 4, 5].map((size) => <button key={size} onClick={() => setGridSize(size as 3 | 4 | 5)} className={`rounded-xl py-2 font-black ${gridSize === size ? "bg-[#FFD700] text-black" : "bg-white/[0.04] text-white/38"}`}>{size}x{size}</button>)}
              </div>
            </div>
            <div>
              <p className="font-mono text-[9px] tracking-[0.16em] uppercase text-white/35 mb-1">Mines</p>
              <div className="rounded-xl bg-white/[0.04] border border-white/10 h-[40px] flex items-center justify-between px-3">
                <button onClick={() => setMinesCount(Math.max(1, minesCount - 1))}><ChevronDown size={17} className="text-white/40" /></button>
                <span className="text-xl font-black" style={{ color: accent }}>{minesCount}</span>
                <button onClick={() => setMinesCount(Math.min(gridSize * gridSize - 2, minesCount + 1))}><ChevronUp size={17} className="text-white/40" /></button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div>
              <p className="font-mono text-[9px] tracking-[0.16em] uppercase text-white/35 mb-1">Bet amount ({currency})</p>
              <div className="rounded-2xl bg-white/[0.04] border border-white/10 h-14 flex items-center justify-between px-4">
                <button onClick={() => setBet(Math.max(minBet, bet - minBet))}><ChevronDown size={18} className="text-white/40" /></button>
                <div className="text-center">
                  <div className="text-xl font-black text-white">{bet.toLocaleString()}</div>
                  <div className="font-mono text-[9px] text-white/28">Balance: {balance.toLocaleString()}</div>
                </div>
                <button onClick={() => setBet(Math.min(maxBet, bet + minBet))}><ChevronUp size={18} className="text-white/40" /></button>
              </div>
            </div>
            <button onClick={() => setBet(maxBet)} className="h-14 px-4 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/10 text-[#FFD700] font-black">MAX</button>
          </div>
        </section>
      )}

      <section className="mines-glass rounded-3xl p-3 mb-3">
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-white/36">Next tile</div>
            <div className="text-2xl font-black" style={{ color: roundAccent }}>{nextMultiplier.toFixed(2)}x</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3 text-right">
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-white/36">Cash out</div>
            <div className="text-2xl font-black text-white">{activeRound ? cashoutValue.toLocaleString() : bet.toLocaleString()} {activeRound ? roundCurrency : currency}</div>
          </div>
        </div>
        {activeRound ? (
          <button onClick={cashout} disabled={!canCashout} className="w-full h-14 rounded-2xl font-black text-black disabled:opacity-40" style={{ background: canCashout ? "linear-gradient(135deg,#FFE266,#FFD700)" : "rgba(255,255,255,0.24)" }}><Trophy size={18} className="inline mr-2" />CASH OUT {cashoutValue.toLocaleString()} {roundCurrency}</button>
        ) : (
          <button onClick={startRound} disabled={!canStart} className="w-full h-14 rounded-2xl font-black text-black disabled:opacity-40" style={{ background: canStart ? "linear-gradient(135deg,#FFE266,#FFD700)" : "rgba(255,255,255,0.24)" }}><Sparkles size={18} className="inline mr-2" />START ROUND</button>
        )}
      </section>

      {error && <div className="mb-3 rounded-2xl border border-[#FF9800]/25 bg-[#FF9800]/8 p-3 font-mono text-[11px] text-[#FFB74D]">{error}</div>}

      <section className="grid gap-2" style={{ gridTemplateColumns: `repeat(${currentGridSize}, minmax(0, 1fr))` }}>
        {Array.from({ length: totalTiles }, (_, i) => {
          const isRevealed = revealed.includes(i) || result?.hitTile === i;
          const isMine = result?.mines?.includes(i) ?? false;
          return <Tile key={i} index={i} revealed={isRevealed} mine={isMine} disabled={!activeRound || loadingTile !== null || !!result} onClick={() => revealTile(i)} accent={roundAccent} />;
        })}
      </section>

      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[90] bg-black/78 flex items-end justify-center" onClick={() => setResult(null)}>
            <motion.div initial={{ y: 220 }} animate={{ y: 0 }} exit={{ y: 220 }} className="w-full max-w-[420px] rounded-t-3xl border-t border-[#FFD700]/25 bg-[#070A12] p-6 text-center" onClick={(e) => e.stopPropagation()}>
              <div className={result.won ? "text-4xl font-black text-[#FFD700]" : "text-4xl font-black text-[#FF1744]"}>{result.won ? "CASHED OUT" : "MINE HIT"}</div>
              <div className="font-mono text-white/50 mt-2">{result.won ? `+${(result.payout ?? 0).toLocaleString()} ${result.mode === "gc" && result.tier !== "gold" ? "GC" : "TC"}` : "Round lost"}</div>
              <button onClick={() => setResult(null)} className="mt-5 w-full rounded-2xl bg-[#FFD700] py-3 font-mono text-sm font-black text-black">CONTINUE</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

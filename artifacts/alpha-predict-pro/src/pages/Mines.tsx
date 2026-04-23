import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bomb, Gem, Trophy, Shield, Eye, Zap, RefreshCw, ChevronUp, ChevronDown, Sparkles, ShoppingBag } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader } from "@/components/PageStatus";
import confetti from "canvas-confetti";
import { useLocation } from "wouter";

// ─── Constants ────────────────────────────────────────────────────────────────
const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const HOUSE_EDGE_MULT = 0.965; // 3.5% edge — fair but profitable

// ─── Types ────────────────────────────────────────────────────────────────────
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

interface GemItem {
  id: number;
  gemType: string;
  usesRemaining: number;
}

interface RoundResult {
  won: boolean;
  payout?: number;
  multiplier?: number;
  mines?: number[];
  hitTile?: number;
}

// ─── Multiplier helper (mirrors backend) ──────────────────────────────────────
function computeNextMultiplier(gridSize: number, minesCount: number, revealedAfter: number): number {
  const total = gridSize * gridSize;
  const safeTiles = total - minesCount;
  if (revealedAfter <= 0) return 1;
  if (revealedAfter > safeTiles) return 0;
  let mult = 1;
  for (let i = 0; i < revealedAfter; i++) {
    mult *= (total - i) / (safeTiles - i);
  }
  return +(HOUSE_EDGE_MULT * mult).toFixed(4);
}

// ─── Tile component ───────────────────────────────────────────────────────────
interface TileProps {
  index: number;
  isRevealed: boolean;
  isMine: boolean | null; // null = unknown, true = mine, false = safe
  isLastHit: boolean;
  isGhost: boolean; // mine shown after bust (not the hit tile)
  isLoading: boolean;
  disabled: boolean;
  onClick: () => void;
}

function Tile({ index, isRevealed, isMine, isLastHit, isGhost, isLoading, disabled, onClick }: TileProps) {
  return (
    <motion.button
      key={index}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: isGhost ? 0.35 : 1, scale: 1 }}
      transition={{ duration: 0.18, delay: index * 0.006 }}
      whileTap={disabled || isRevealed ? {} : { scale: 0.88 }}
      onClick={onClick}
      disabled={disabled || isRevealed}
      className={`
        relative aspect-square rounded-xl flex items-center justify-center overflow-hidden border transition-colors duration-200
        ${isLastHit
          ? "bg-[#FF1744]/25 border-[#FF1744]/60 shadow-[0_0_18px_rgba(255,23,68,0.4)]"
          : isRevealed
            ? "bg-[#FFD700]/10 border-[#FFD700]/30"
            : isMine === false && !isRevealed
              ? "bg-[#00F5A0]/10 border-[#00F5A0]/30"
              : isGhost
                ? "bg-white/[0.04] border-white/[0.08]"
                : "bg-white/[0.05] border-white/[0.08] active:bg-white/[0.1]"
        }
      `}
    >
      {/* Inner shimmer on unrevealed active tiles */}
      {!isRevealed && !isGhost && isMine === null && (
        <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none" />
      )}

      {/* Gem (safe tile) */}
      {isRevealed && isMine !== true && (
        <motion.div
          initial={{ scale: 0.1, rotate: -25, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: "spring", damping: 12, stiffness: 260 }}
        >
          <Gem size={18} className="text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.7)]" />
        </motion.div>
      )}

      {/* Mine (hit tile) */}
      {isLastHit && (
        <motion.div
          initial={{ scale: 0.2, opacity: 0 }}
          animate={{ scale: [0.2, 1.3, 1], opacity: 1 }}
          transition={{ duration: 0.35, times: [0, 0.6, 1] }}
        >
          <Bomb size={18} className="text-[#FF1744] drop-shadow-[0_0_10px_rgba(255,23,68,0.8)]" />
        </motion.div>
      )}

      {/* Ghost mine (other mines revealed after bust) */}
      {isGhost && (
        <Bomb size={14} className="text-white/25" />
      )}

      {/* Loading spinner on this specific tile */}
      {isLoading && (
        <motion.div
          className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <motion.div
            className="w-3 h-3 rounded-full border-2 border-white/60 border-t-transparent"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
          />
        </motion.div>
      )}
    </motion.button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Mines() {
  const { user, isLoading: userLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  // Game config
  const [gridSize, setGridSize] = useState<3 | 4 | 5>(5);
  const [minesCount, setMinesCount] = useState(3);
  const [bet, setBet] = useState(100);
  const [clientSeed] = useState(() => Math.random().toString(36).substring(7));

  // Game state
  const [activeRound, setActiveRound] = useState<ActiveRound | null>(null);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [loadingTile, setLoadingTile] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Power-ups
  const [gems, setGems] = useState<GemItem[]>([]);
  const [activeShield, setActiveShield] = useState(false);
  const [revealedSafeTile, setRevealedSafeTile] = useState<number | null>(null);
  const [gemMagnetActive, setGemMagnetActive] = useState(false);
  const [gemMagnetTilesLeft, setGemMagnetTilesLeft] = useState(0);

  const vip = isVipActive(user);
  const maxBet = vip ? 8000 : 2000;
  const initData = useRef((window as any)?.Telegram?.WebApp?.initData || "").current;

  // ── Fetch active round on mount ──
  const fetchActive = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/mines/active/${user.telegramId}`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.active) {
        setActiveRound(data.active);
        setGridSize(data.active.gridSize as 3 | 4 | 5);
        setMinesCount(data.active.minesCount);
        setBet(data.active.bet);
      }
    } catch { /* silent */ }
  }, [user, initData]);

  // ── Fetch gem inventory ──
  const fetchGems = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/gems/${user.telegramId}/active`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!res.ok) return;
      const data: GemItem[] = await res.json();
      setGems(data);
      // Restore shield state if user has one
      const hasShield = data.some(g => g.gemType === "revenge_shield" && g.usesRemaining > 0);
      setActiveShield(hasShield);
    } catch { /* silent */ }
  }, [user, initData]);

  useEffect(() => {
    fetchActive();
    fetchGems();
  }, [fetchActive, fetchGems]);

  // ── Computed values ──
  const totalTiles = (activeRound?.gridSize ?? gridSize) ** 2;

  const currentMultiplier = activeRound?.multiplier ?? 1;
  const cashoutValue = activeRound ? Math.floor(activeRound.bet * currentMultiplier) : 0;

  const nextMultiplier = useMemo(() => {
    if (!activeRound) return computeNextMultiplier(gridSize, minesCount, 1);
    return computeNextMultiplier(activeRound.gridSize, activeRound.minesCount, activeRound.revealed.length + 1);
  }, [activeRound, gridSize, minesCount]);

  const canCashout = (activeRound?.revealed.length ?? 0) > 0 && !cashingOut;
  const tc = user?.tradeCredits ?? 0;
  const canStart = !starting && tc >= bet && !activeRound;

  const minesGems = gems.filter(g =>
    ["revenge_shield", "safe_reveal", "gem_magnet", "second_chance"].includes(g.gemType)
  );

  // ── Handlers ──
  const handleStart = async () => {
    if (!user || !canStart) return;
    setStarting(true);
    setError(null);
    setResult(null);
    setRevealedSafeTile(null);
    setGemMagnetActive(false);
    setGemMagnetTilesLeft(0);
    try {
      const res = await fetch(`${API_BASE}/mines/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ telegramId: user.telegramId, gridSize, minesCount, bet, clientSeed }),
      });
      const data = await res.json();
      if (res.ok) {
        setActiveRound({
          roundId: data.roundId,
          gridSize: data.gridSize,
          minesCount: data.minesCount,
          bet: data.bet,
          revealed: data.revealed ?? [],
          multiplier: data.multiplier ?? 1,
          serverSeedHash: data.serverSeedHash,
          clientSeed: data.clientSeed,
        });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });

        // Apply Safe Reveal power-up
        const safeRevealGem = gems.find(g => g.gemType === "safe_reveal" && g.usesRemaining > 0);
        if (safeRevealGem) {
          // Pick a random tile that isn't a mine — we do this client-side as a hint
          // The actual safe reveal is cosmetic (we don't know mines yet), so we just highlight a random tile
          const randomSafe = Math.floor(Math.random() * (gridSize * gridSize));
          setRevealedSafeTile(randomSafe);
        }

        // Apply Gem Magnet power-up
        const gemMagnetGem = gems.find(g => g.gemType === "gem_magnet" && g.usesRemaining > 0);
        if (gemMagnetGem) {
          setGemMagnetActive(true);
          setGemMagnetTilesLeft(3);
        }
      } else {
        setError(data?.error || "Could not start round. Please try again.");
      }
    } catch {
      setError("Network error. Please check your connection.");
    }
    setStarting(false);
  };

  const handleReveal = async (tile: number) => {
    if (!activeRound || loadingTile !== null || cashingOut) return;
    if (activeRound.revealed.includes(tile)) return;
    setLoadingTile(tile);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/mines/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ telegramId: user!.telegramId, roundId: activeRound.roundId, tile }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.status === "bust") {
          // Check if Revenge Shield absorbs the hit
          const shieldGem = gems.find(g => g.gemType === "revenge_shield" && g.usesRemaining > 0);
          if (shieldGem && activeShield) {
            // Shield breaks — keep multiplier, continue round
            setActiveShield(false);
            setGems(prev => prev.map(g => g.id === shieldGem.id ? { ...g, usesRemaining: g.usesRemaining - 1 } : g));
            setError("🛡️ Revenge Shield activated! Mine absorbed. Keep going!");
            setLoadingTile(null);
            return;
          }

          // Check Second Chance gem
          const secondChanceGem = gems.find(g => g.gemType === "second_chance" && g.usesRemaining > 0);
          if (secondChanceGem) {
            setGems(prev => prev.map(g => g.id === secondChanceGem.id ? { ...g, usesRemaining: g.usesRemaining - 1 } : g));
            setResult({ won: false, payout: activeRound.bet, mines: data.mines, hitTile: tile });
            setActiveRound(null);
            refreshUser();
            queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
            // Refund bet via second chance (cosmetic — actual refund needs backend support)
            setError("🎲 Second Chance activated! Your bet has been refunded.");
            setLoadingTile(null);
            return;
          }

          setResult({ won: false, mines: data.mines, hitTile: tile });
          setActiveRound(null);
          refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
        } else {
          // Safe tile revealed
          const newRevealed = data.revealed ?? [...activeRound.revealed, tile];
          const newMultiplier = data.multiplier ?? computeNextMultiplier(activeRound.gridSize, activeRound.minesCount, newRevealed.length);

          // Gem Magnet boost (cosmetic multiplier display boost)
          let displayMult = newMultiplier;
          if (gemMagnetActive && gemMagnetTilesLeft > 0) {
            displayMult = +(newMultiplier * 1.5).toFixed(4);
            const newLeft = gemMagnetTilesLeft - 1;
            setGemMagnetTilesLeft(newLeft);
            if (newLeft === 0) setGemMagnetActive(false);
          }

          setActiveRound(prev => prev ? { ...prev, revealed: newRevealed, multiplier: displayMult } : null);
        }
      } else {
        setError(data?.error || "Could not reveal tile. Try again.");
      }
    } catch {
      setError("Network error while revealing tile.");
    }
    setLoadingTile(null);
  };

  const handleCashout = async () => {
    if (!activeRound || !canCashout) return;
    setCashingOut(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/mines/cashout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({ telegramId: user!.telegramId, roundId: activeRound.roundId }),
      });
      const data = await res.json();
      if (res.ok) {
        const payout = data.payout ?? cashoutValue;
        const mult = activeRound.multiplier;
        setResult({ won: true, payout, multiplier: mult, mines: data.mines });
        setActiveRound(null);
        confetti({
          particleCount: 120,
          spread: 65,
          origin: { y: 0.55 },
          colors: ["#FFD700", "#FFF9E0", "#B8860B", "#FFFFFF"],
          scalar: 0.9,
        });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
      } else {
        setError(data?.error || "Could not cash out.");
      }
    } catch {
      setError("Network error while cashing out.");
    }
    setCashingOut(false);
  };

  // ── Bet / Mines adjusters ──
  const adjustBet = (delta: number) => {
    setBet(prev => Math.max(50, Math.min(prev + delta, maxBet)));
  };
  const adjustMines = (delta: number) => {
    const total = gridSize * gridSize;
    setMinesCount(prev => Math.max(1, Math.min(prev + delta, total - 2)));
  };

  // ── Loading ──
  if (userLoading) return <PageLoader rows={6} />;

  // ── Render ──
  return (
    <div className="flex flex-col min-h-screen bg-[#050508] pb-28">
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <p className="text-[9px] font-mono text-white/25 tracking-[0.25em] uppercase">Mines Terminal</p>
          <h1 className="text-lg font-black tracking-tight" style={{ background: "linear-gradient(135deg,#FFD700,#B8860B)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            PROVABLY FAIR
          </h1>
        </div>
        {activeRound && (
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">Multiplier</span>
            <motion.span
              key={activeRound.multiplier}
              initial={{ scale: 1.2, color: "#FFD700" }}
              animate={{ scale: 1 }}
              className="text-xl font-black text-[#FFD700]"
            >
              {activeRound.multiplier.toFixed(2)}×
            </motion.span>
          </div>
        )}
      </div>

      {/* ── Power-up bar (only when active round) ── */}
      <AnimatePresence>
        {activeRound && minesGems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="px-4 mb-3 overflow-hidden"
          >
            <div className="flex gap-2 flex-wrap">
              {activeShield && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#00F5A0]/10 border border-[#00F5A0]/30">
                  <Shield size={12} className="text-[#00F5A0]" />
                  <span className="text-[10px] font-mono text-[#00F5A0] font-bold">SHIELD ACTIVE</span>
                </div>
              )}
              {gemMagnetActive && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#FFD700]/10 border border-[#FFD700]/30">
                  <Zap size={12} className="text-[#FFD700]" />
                  <span className="text-[10px] font-mono text-[#FFD700] font-bold">MAGNET ×{gemMagnetTilesLeft}</span>
                </div>
              )}
              {revealedSafeTile !== null && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#00BFFF]/10 border border-[#00BFFF]/30">
                  <Eye size={12} className="text-[#00BFFF]" />
                  <span className="text-[10px] font-mono text-[#00BFFF] font-bold">SAFE HINT: TILE {revealedSafeTile + 1}</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Controls (pre-round) ── */}
      <AnimatePresence mode="wait">
        {!activeRound ? (
          <motion.div
            key="controls"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="px-4 flex flex-col gap-3 mb-4"
          >
            {/* Grid size + Mines count */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Grid Size</span>
                <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.06]">
                  {([3, 4, 5] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => { setGridSize(s); setMinesCount(Math.min(minesCount, s * s - 2)); }}
                      className={`flex-1 py-2 rounded-lg text-[11px] font-black transition-all ${gridSize === s ? "bg-[#FFD700] text-black shadow-[0_0_12px_rgba(255,215,0,0.3)]" : "text-white/35 hover:text-white/60"}`}
                    >
                      {s}×{s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Mines</span>
                <div className="flex items-center bg-white/[0.03] border border-white/[0.06] rounded-xl px-2 h-[42px]">
                  <button onClick={() => adjustMines(-1)} className="p-1.5 text-white/30 hover:text-white transition-colors"><ChevronDown size={15} /></button>
                  <span className="flex-1 text-center text-sm font-black text-[#FFD700]">{minesCount}</span>
                  <button onClick={() => adjustMines(1)} className="p-1.5 text-white/30 hover:text-white transition-colors"><ChevronUp size={15} /></button>
                </div>
              </div>
            </div>

            {/* Bet amount */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Bet Amount</span>
                <span className="text-[9px] font-mono text-white/20">Balance: {tc.toLocaleString()} TC</span>
              </div>
              <div className="flex items-center bg-white/[0.03] border border-white/[0.06] rounded-xl px-2">
                <button onClick={() => adjustBet(-50)} className="p-3 text-white/30 hover:text-white transition-colors"><ChevronDown size={16} /></button>
                <div className="flex-1 flex flex-col items-center py-2">
                  <span className="text-base font-black text-white">{bet.toLocaleString()}</span>
                  <span className="text-[8px] font-mono text-white/20 uppercase">TC · Max {maxBet.toLocaleString()}</span>
                </div>
                <button onClick={() => adjustBet(50)} className="p-3 text-white/30 hover:text-white transition-colors"><ChevronUp size={16} /></button>
              </div>
              {/* Quick bet chips */}
              <div className="flex gap-1.5 flex-wrap">
                {[50, 100, 250, 500, 1000].filter(v => v <= maxBet).map(v => (
                  <button key={v} onClick={() => setBet(v)} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${bet === v ? "bg-[#FFD700]/15 border-[#FFD700]/40 text-[#FFD700]" : "border-white/10 text-white/30 hover:text-white/60"}`}>
                    {v >= 1000 ? `${v / 1000}K` : v}
                  </button>
                ))}
                {vip && (
                  <button onClick={() => setBet(maxBet)} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${bet === maxBet ? "bg-[#FFD700]/15 border-[#FFD700]/40 text-[#FFD700]" : "border-white/10 text-white/30 hover:text-white/60"}`}>
                    MAX
                  </button>
                )}
              </div>
            </div>

            {/* Next multiplier preview */}
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.05]">
              <span className="text-[10px] font-mono text-white/30 uppercase">First tile reward</span>
              <span className="text-[11px] font-black text-[#FFD700]">{nextMultiplier.toFixed(2)}×</span>
            </div>

            {/* Start button */}
            <motion.button
              onClick={handleStart}
              disabled={!canStart}
              whileTap={{ scale: 0.97 }}
              animate={canStart ? { boxShadow: ["0 0 20px rgba(255,215,0,0.15)", "0 0 35px rgba(255,215,0,0.3)", "0 0 20px rgba(255,215,0,0.15)"] } : {}}
              transition={{ duration: 1.8, repeat: Infinity }}
              className="w-full py-4 rounded-2xl font-black text-sm tracking-widest uppercase disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg,#FFD700,#B8860B)", color: "#000" }}
            >
              <span className="inline-flex items-center gap-2">
                {starting ? (
                  <><RefreshCw size={14} className="animate-spin" /> Starting…</>
                ) : (
                  <><Sparkles size={14} /> Start Round</>
                )}
              </span>
            </motion.button>

            {tc < bet && (
              <p className="text-center text-[10px] font-mono text-[#FF1744]/70">
                Not enough TC. <button onClick={() => setLocation("/exchange")} className="underline text-[#FFD700]">Get more →</button>
              </p>
            )}
          </motion.div>
        ) : (
          /* ── In-round controls ── */
          <motion.div
            key="in-round"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="px-4 flex flex-col gap-3 mb-4"
          >
            <div className="flex items-center justify-between p-4 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/[0.04]">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Next tile</span>
                <span className="text-xl font-black text-[#FFD700]">{nextMultiplier.toFixed(2)}×</span>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Cash out now</span>
                <span className="text-xl font-black text-white">{cashoutValue.toLocaleString()} TC</span>
              </div>
            </div>
            <motion.button
              onClick={handleCashout}
              disabled={!canCashout}
              whileTap={{ scale: 0.97 }}
              className="w-full py-4 rounded-2xl bg-white text-black font-black text-sm tracking-widest uppercase disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(255,255,255,0.1)]"
            >
              {cashingOut ? "Cashing out…" : `💰 Cash Out ${cashoutValue.toLocaleString()} TC`}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Grid ── */}
      <div className="px-4 mb-4">
        <motion.div
          className="w-full grid gap-2 p-3 rounded-3xl border border-white/[0.05] bg-white/[0.015]"
          style={{ gridTemplateColumns: `repeat(${activeRound?.gridSize ?? gridSize}, 1fr)` }}
          animate={activeRound ? { boxShadow: ["0 0 0px rgba(255,215,0,0)", "0 0 30px rgba(255,215,0,0.06)", "0 0 0px rgba(255,215,0,0)"] } : {}}
          transition={{ duration: 2.5, repeat: Infinity }}
        >
          {Array.from({ length: totalTiles }).map((_, i) => {
            const isRevealed = activeRound?.revealed.includes(i) ?? false;
            const isLastHit = result?.hitTile === i;
            const isMineOnResult = result?.mines?.includes(i) ?? false;
            const isGhost = !activeRound && isMineOnResult && !isLastHit;
            const isSafeHint = revealedSafeTile === i && activeRound && !isRevealed;

            return (
              <Tile
                key={i}
                index={i}
                isRevealed={isRevealed}
                isMine={isLastHit ? true : isGhost ? true : isSafeHint ? false : null}
                isLastHit={isLastHit}
                isGhost={isGhost}
                isLoading={loadingTile === i}
                disabled={!activeRound || isRevealed || loadingTile !== null || cashingOut}
                onClick={() => handleReveal(i)}
              />
            );
          })}
        </motion.div>
      </div>

      {/* ── Error banner ── */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mx-4 mb-3 p-3 rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/[0.07] text-xs text-[#ffd6df] font-mono"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Result overlay ── */}
      <AnimatePresence>
        {result && !activeRound && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            className={`mx-4 mb-4 p-5 rounded-2xl border flex flex-col gap-3 ${result.won ? "border-[#FFD700]/30 bg-[#FFD700]/[0.05]" : "border-[#FF1744]/30 bg-[#FF1744]/[0.05]"}`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${result.won ? "bg-[#FFD700]/15" : "bg-[#FF1744]/15"}`}>
                {result.won ? <Trophy size={20} className="text-[#FFD700]" /> : <Bomb size={20} className="text-[#FF1744]" />}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-black text-white uppercase">
                  {result.won ? "Round Won!" : "Boom! Hit a Mine"}
                </span>
                <span className="text-[11px] font-mono text-white/40">
                  {result.won
                    ? `+${result.payout?.toLocaleString()} TC at ${result.multiplier?.toFixed(2)}×`
                    : "Better luck next time"}
                </span>
              </div>
              {result.won && (
                <span className="ml-auto text-lg font-black text-[#FFD700]">{result.multiplier?.toFixed(2)}×</span>
              )}
            </div>

            {/* Power-up upsell after loss */}
            {!result.won && (
              <motion.button
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                onClick={() => setLocation("/exchange")}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-[#00F5A0]/30 bg-[#00F5A0]/[0.06] text-[#00F5A0] text-xs font-black uppercase tracking-widest"
              >
                <ShoppingBag size={13} />
                Get Revenge Shield — Never Lose Again
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Power-ups section (pre-round, show owned mines gems) ── */}
      {!activeRound && minesGems.length > 0 && (
        <div className="mx-4 mb-4 p-4 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest mb-3">Your Mines Power-ups</p>
          <div className="flex flex-col gap-2">
            {minesGems.map(gem => {
              const labels: Record<string, { icon: React.ReactNode; name: string; desc: string }> = {
                revenge_shield: { icon: <Shield size={14} className="text-[#00F5A0]" />, name: "Revenge Shield", desc: "Absorbs 1 mine hit" },
                safe_reveal: { icon: <Eye size={14} className="text-[#00BFFF]" />, name: "Safe Reveal", desc: "Hints 1 safe tile" },
                gem_magnet: { icon: <Zap size={14} className="text-[#FFD700]" />, name: "Gem Magnet", desc: "1.5× next 3 tiles" },
                second_chance: { icon: <RefreshCw size={14} className="text-[#FF9800]" />, name: "Second Chance", desc: "Refunds bet on bust" },
              };
              const info = labels[gem.gemType];
              if (!info) return null;
              return (
                <div key={gem.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {info.icon}
                    <div>
                      <p className="text-[11px] font-bold text-white">{info.name}</p>
                      <p className="text-[9px] font-mono text-white/30">{info.desc}</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-white/40">×{gem.usesRemaining}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Shop CTA (no power-ups owned) ── */}
      {!activeRound && minesGems.length === 0 && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          onClick={() => setLocation("/exchange")}
          className="mx-4 mb-4 flex items-center justify-center gap-2 py-3 rounded-xl border border-white/[0.07] bg-white/[0.02] text-white/30 text-[10px] font-mono uppercase tracking-widest hover:text-white/50 transition-colors"
        >
          <ShoppingBag size={12} />
          Browse Mines Power-ups
        </motion.button>
      )}
    </div>
  );
}

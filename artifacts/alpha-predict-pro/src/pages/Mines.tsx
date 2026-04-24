import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bomb, Gem, Trophy, Shield, Eye, Zap, RefreshCw,
  ChevronUp, ChevronDown, Sparkles, ShoppingBag, Check, X,
  Crown, Lock, Coins, Star,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader } from "@/components/PageStatus";
import confetti from "canvas-confetti";
import { useLocation } from "wouter";

// ─── Constants ────────────────────────────────────────────────────────────────
const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const HOUSE_EDGE_MULT = 0.945;

// ─── Types ────────────────────────────────────────────────────────────────────
type GameMode = "tc" | "gc";
type GcTierId = "bronze" | "silver" | "gold";

interface ActiveGemsState {
  revenge_shield?: boolean;
  safe_reveal_used?: boolean;
  gem_magnet_left?: number;
  second_chance?: boolean;
}

interface ActiveRound {
  roundId: number;
  gridSize: number;
  minesCount: number;
  bet: number;
  mode: GameMode;
  tier: GcTierId | null;
  revealed: number[];
  multiplier: number;
  serverSeedHash: string;
  clientSeed: string;
  activeGems: ActiveGemsState;
}

interface GemItem {
  id: number;
  gemType: string;
  usesRemaining: number;
}

interface RoundResult {
  won: boolean;
  payout?: number;
  gcPayout?: number;
  tcPayout?: number;
  multiplier?: number;
  mines?: number[];
  hitTile?: number;
  secondChance?: boolean;
  refund?: number;
  mode?: GameMode;
  tier?: GcTierId | null;
}

interface PassesData {
  passes: Record<string, number>;
  dailyGcFromMines: number;
  dailyGcCap: number;
  dailyGcRemaining: number;
}

// ─── Tier config (mirrors backend) ────────────────────────────────────────────
const GC_TIER_CONFIG: Record<GcTierId, {
  label: string;
  currency: "gc" | "tc";
  reward: "gc";
  minBet: number;
  maxBet: number;
  maxPayoutGc: number;
  entryFeeTon: string;
  entryFeeTonNano: string;
  color: string;
  icon: typeof Crown;
  desc: string;
}> = {
  bronze: {
    label: "Bronze",
    currency: "gc",
    reward: "gc",
    minBet: 500,
    maxBet: 3_000,
    maxPayoutGc: 15_000,
    entryFeeTon: "0.05",
    entryFeeTonNano: "50000000",
    color: "#CD7F32",
    icon: Coins,
    desc: "Bet GC → Win GC",
  },
  silver: {
    label: "Silver",
    currency: "gc",
    reward: "gc",
    minBet: 1_000,
    maxBet: 8_000,
    maxPayoutGc: 40_000,
    entryFeeTon: "0.10",
    entryFeeTonNano: "100000000",
    color: "#C0C0C0",
    icon: Star,
    desc: "Bet GC → Win GC",
  },
  gold: {
    label: "Gold",
    currency: "tc",
    reward: "gc",
    minBet: 500,
    maxBet: 5_000,
    maxPayoutGc: 25_000,
    entryFeeTon: "0.25",
    entryFeeTonNano: "250000000",
    color: "#FFD700",
    icon: Crown,
    desc: "Bet TC → Win GC",
  },
};

// ─── Multiplier helper ────────────────────────────────────────────────────────
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

// ─── Gem metadata ─────────────────────────────────────────────────────────────
const GEM_META: Record<string, { icon: typeof Shield; name: string; desc: string; color: string }> = {
  revenge_shield: { icon: Shield, name: "Revenge Shield", desc: "Absorbs 1 mine hit", color: "#00F5A0" },
  safe_reveal:    { icon: Eye,    name: "Safe Reveal",    desc: "Server reveals 1 safe tile", color: "#00BFFF" },
  gem_magnet:     { icon: Zap,    name: "Gem Magnet",     desc: "1.25× boost for 3 tiles", color: "#FFD700" },
  second_chance:  { icon: RefreshCw, name: "Second Chance", desc: "Refunds bet on bust", color: "#FF9800" },
};
const MINES_GEM_TYPES = Object.keys(GEM_META);

// ─── Tile component ───────────────────────────────────────────────────────────
interface TileProps {
  index: number;
  isRevealed: boolean;
  isMine: boolean | null;
  isLastHit: boolean;
  isShielded: boolean;
  isGhost: boolean;
  isSafeHint: boolean;
  isLoading: boolean;
  disabled: boolean;
  onClick: () => void;
  accentColor: string;
}

function Tile({ index, isRevealed, isMine, isLastHit, isShielded, isGhost, isSafeHint, isLoading, disabled, onClick, accentColor }: TileProps) {
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
        relative aspect-square rounded-xl border flex items-center justify-center transition-all
        ${isRevealed && isMine !== true && !isShielded
          ? `border-[${accentColor}]/30 bg-[${accentColor}]/[0.08]`
          : isLastHit && !isShielded
            ? "border-[#FF1744]/40 bg-[#FF1744]/[0.12]"
            : isShielded
              ? "border-[#00F5A0]/40 bg-[#00F5A0]/[0.08]"
              : "bg-white/[0.05] border-white/[0.08] active:bg-white/[0.1]"
        }
      `}
      style={
        isRevealed && isMine !== true && !isShielded
          ? { borderColor: `${accentColor}4D`, backgroundColor: `${accentColor}14` }
          : undefined
      }
    >
      {!isRevealed && !isGhost && !isSafeHint && isMine === null && (
        <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent pointer-events-none rounded-xl" />
      )}
      {isSafeHint && !isRevealed && (
        <motion.div animate={{ scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] }} transition={{ duration: 1.5, repeat: Infinity }}>
          <Eye size={16} className="text-[#00BFFF]" />
        </motion.div>
      )}
      {isRevealed && isMine !== true && !isShielded && (
        <motion.div initial={{ scale: 0.1, rotate: -25, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: "spring", damping: 12, stiffness: 260 }}>
          <Gem size={18} style={{ color: accentColor, filter: `drop-shadow(0 0 10px ${accentColor}B3)` }} />
        </motion.div>
      )}
      {isShielded && (
        <motion.div initial={{ scale: 0.2, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", damping: 10 }}>
          <Shield size={18} className="text-[#00F5A0] drop-shadow-[0_0_10px_rgba(0,245,160,0.7)]" />
        </motion.div>
      )}
      {isLastHit && !isShielded && (
        <motion.div initial={{ scale: 0.2, opacity: 0 }} animate={{ scale: [0.2, 1.3, 1], opacity: 1 }} transition={{ duration: 0.35, times: [0, 0.6, 1] }}>
          <Bomb size={18} className="text-[#FF1744] drop-shadow-[0_0_10px_rgba(255,23,68,0.8)]" />
        </motion.div>
      )}
      {isGhost && <Bomb size={14} className="text-white/25" />}
      {isLoading && (
        <motion.div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-xl" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <motion.div className="w-3 h-3 rounded-full border-2 border-white/60 border-t-transparent" animate={{ rotate: 360 }} transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }} />
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

  // Mode & tier
  const [mode, setMode] = useState<GameMode>("tc");
  const [selectedTier, setSelectedTier] = useState<GcTierId>("bronze");

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

  // Power-up selection
  const [gems, setGems] = useState<GemItem[]>([]);
  const [selectedGemIds, setSelectedGemIds] = useState<number[]>([]);

  // In-round power-up state
  const [shieldedTiles, setShieldedTiles] = useState<number[]>([]);
  const [safeTileHint, setSafeTileHint] = useState<number | null>(null);

  // GC Mines passes
  const [passesData, setPassesData] = useState<PassesData | null>(null);
  const [buyingPass, setBuyingPass] = useState(false);

  const vip = isVipActive(user);
  const initData = useRef((window as any)?.Telegram?.WebApp?.initData || "").current;

  // Computed values based on mode
  const activeTierConfig = mode === "gc" ? GC_TIER_CONFIG[selectedTier] : null;
  const currencyLabel = mode === "gc" && activeTierConfig ? activeTierConfig.currency.toUpperCase() : "TC";
  const accentColor = mode === "gc" && activeTierConfig ? activeTierConfig.color : "#FFD700";

  const maxBet = mode === "gc" && activeTierConfig
    ? activeTierConfig.maxBet
    : (vip ? 8000 : 2000);
  const minBet = mode === "gc" && activeTierConfig
    ? activeTierConfig.minBet
    : 50;

  const userBalance = mode === "gc" && activeTierConfig?.currency === "gc"
    ? (user?.goldCoins ?? 0)
    : (user?.tradeCredits ?? 0);

  const passesForTier = passesData?.passes?.[selectedTier] ?? 0;

  // ── Fetch active round ──
  const fetchActive = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/mines/active/${user.telegramId}`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.active) {
        setActiveRound({
          roundId: data.active.roundId,
          gridSize: data.active.gridSize,
          minesCount: data.active.minesCount,
          bet: data.active.bet,
          mode: data.active.mode ?? "tc",
          tier: data.active.tier ?? null,
          revealed: data.active.revealed ?? [],
          multiplier: data.active.multiplier ?? 1,
          serverSeedHash: data.active.serverSeedHash,
          clientSeed: data.active.clientSeed,
          activeGems: data.active.activeGems ?? {},
        });
        setGridSize(data.active.gridSize as 3 | 4 | 5);
        setMinesCount(data.active.minesCount);
        setBet(data.active.bet);
        if (data.active.mode) setMode(data.active.mode);
        if (data.active.tier) setSelectedTier(data.active.tier);
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
    } catch { /* silent */ }
  }, [user, initData]);

  // ── Fetch round passes ──
  const fetchPasses = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch(`${API_BASE}/mines/passes/${user.telegramId}`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (!res.ok) return;
      const data: PassesData = await res.json();
      setPassesData(data);
    } catch { /* silent */ }
  }, [user, initData]);

  useEffect(() => {
    fetchActive();
    fetchGems();
    fetchPasses();
  }, [fetchActive, fetchGems, fetchPasses]);

  // ── Computed ──
  const currentGridSize = activeRound?.gridSize ?? gridSize;
  const totalTiles = currentGridSize ** 2;
  const currentMultiplier = activeRound?.multiplier ?? 1;
  const cashoutValue = activeRound ? Math.floor(activeRound.bet * currentMultiplier) : 0;

  const nextMultiplier = useMemo(() => {
    if (!activeRound) return computeNextMultiplier(gridSize, minesCount, 1);
    return computeNextMultiplier(activeRound.gridSize, activeRound.minesCount, activeRound.revealed.length + 1);
  }, [activeRound, gridSize, minesCount]);

  const canCashout = (activeRound?.revealed.length ?? 0) > 0 && !cashingOut;
  const canStart = !starting && userBalance >= bet && !activeRound && (mode === "tc" || passesForTier > 0);

  const availableMinesGems = gems.filter(
    (g) => MINES_GEM_TYPES.includes(g.gemType) && g.usesRemaining > 0,
  );

  // ── Toggle gem selection ──
  const toggleGem = (gemId: number) => {
    const gem = availableMinesGems.find((g) => g.id === gemId);
    if (!gem) return;
    setSelectedGemIds((prev) => {
      if (prev.includes(gemId)) return prev.filter((id) => id !== gemId);
      const sameTypeSelected = prev.some((id) => {
        const existing = availableMinesGems.find((g) => g.id === id);
        return existing && existing.gemType === gem.gemType;
      });
      if (sameTypeSelected) return prev;
      return [...prev, gemId];
    });
  };

  // ── Purchase round pass ──
  const handleBuyPass = async (packSize: number) => {
    if (!user || buyingPass) return;
    setBuyingPass(true);
    setError(null);

    try {
      // Use TonConnect to send the payment
      const tonConnect = (window as any)?.tonConnectUI;
      if (!tonConnect) {
        setError("Connect your TON wallet first.");
        setBuyingPass(false);
        return;
      }

      const tierConfig = GC_TIER_CONFIG[selectedTier];
      let totalNano: bigint;
      if (packSize === 1) {
        totalNano = BigInt(tierConfig.entryFeeTonNano);
      } else if (packSize === 5) {
        totalNano = (BigInt(tierConfig.entryFeeTonNano) * 39n) / 10n;
      } else {
        totalNano = (BigInt(tierConfig.entryFeeTonNano) * 69n) / 10n;
      }

      const walletAddr = user.walletAddress;
      if (!walletAddr) {
        setLocation("/wallet");
        setBuyingPass(false);
        return;
      }

      const operatorWallet = import.meta.env.VITE_TON_WALLET as string;
      if (!operatorWallet) {
        setError("Payment not configured.");
        setBuyingPass(false);
        return;
      }

      // Send TON transaction
      const tx = {
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
          {
            address: operatorWallet,
            amount: totalNano.toString(),
          },
        ],
      };

      await tonConnect.sendTransaction(tx);

      // Wait a moment for the tx to propagate, then verify on backend
      await new Promise((r) => setTimeout(r, 5000));

      const res = await fetch(`${API_BASE}/mines/passes/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify({
          telegramId: user.telegramId,
          tier: selectedTier,
          packSize,
          senderAddress: walletAddr,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        await fetchPasses();
        setError(null);
      } else {
        setError(data?.error || "Payment verification failed. Please try again.");
      }
    } catch (e: any) {
      if (e?.message?.includes("Cancelled") || e?.message?.includes("rejected")) {
        setError("Transaction cancelled.");
      } else {
        setError("Payment failed. Please try again.");
      }
    }
    setBuyingPass(false);
  };

  // ── Start round ──
  const handleStart = async () => {
    if (!user || !canStart) return;
    setStarting(true);
    setError(null);
    setResult(null);
    setShieldedTiles([]);
    setSafeTileHint(null);

    try {
      const body: Record<string, unknown> = {
        telegramId: user.telegramId,
        gridSize,
        minesCount,
        bet,
        clientSeed,
        mode,
      };
      if (mode === "gc") body.tier = selectedTier;
      if (selectedGemIds.length > 0) body.useGems = selectedGemIds;

      const res = await fetch(`${API_BASE}/mines/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-telegram-init-data": initData },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setActiveRound({
          roundId: data.roundId,
          gridSize: data.gridSize,
          minesCount: data.minesCount,
          bet: data.bet,
          mode: data.mode ?? mode,
          tier: data.tier ?? null,
          revealed: data.revealed ?? [],
          multiplier: data.multiplier ?? 1,
          serverSeedHash: data.serverSeedHash,
          clientSeed: data.clientSeed,
          activeGems: data.activeGems ?? {},
        });
        if (data.safeTileHint !== null && data.safeTileHint !== undefined) {
          setSafeTileHint(data.safeTileHint);
        }
        setSelectedGemIds([]);
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        fetchGems();
        fetchPasses();
      } else {
        setError(data?.error || "Could not start round.");
      }
    } catch {
      setError("Network error. Please check your connection.");
    }
    setStarting(false);
  };

  // ── Reveal tile ──
  const handleReveal = async (tile: number) => {
    if (!activeRound || loadingTile !== null || cashingOut) return;
    if (activeRound.revealed.includes(tile) || shieldedTiles.includes(tile)) return;
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
        if (data.hit && data.shielded) {
          setShieldedTiles((prev) => [...prev, data.shieldedTile ?? tile]);
          setActiveRound((prev) => prev ? { ...prev, activeGems: data.activeGems ?? {} } : null);
          setError("🛡️ Shield activated! Mine absorbed — keep going!");
        } else if (data.hit && data.secondChance) {
          setResult({ won: false, mines: data.mines, hitTile: tile, secondChance: true, refund: data.refund, mode: activeRound.mode, tier: activeRound.tier });
          setActiveRound(null);
          refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
        } else if (data.hit) {
          setResult({ won: false, mines: data.mines, hitTile: tile, mode: activeRound.mode, tier: activeRound.tier });
          setActiveRound(null);
          refreshUser();
          queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
        } else {
          const newRevealed = data.revealed ?? [...activeRound.revealed, tile];
          const newMultiplier = data.multiplier ?? computeNextMultiplier(activeRound.gridSize, activeRound.minesCount, newRevealed.length);
          setActiveRound((prev) => prev ? { ...prev, revealed: newRevealed, multiplier: newMultiplier, activeGems: data.activeGems ?? prev.activeGems } : null);
          if (safeTileHint === tile) setSafeTileHint(null);
        }
      } else {
        setError(data?.error || "Could not reveal tile.");
      }
    } catch {
      setError("Network error while revealing tile.");
    }
    setLoadingTile(null);
  };

  // ── Cashout ──
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
        setResult({
          won: true,
          payout,
          gcPayout: data.gcPayout,
          tcPayout: data.tcPayout,
          multiplier: activeRound.multiplier,
          mines: data.mines,
          mode: activeRound.mode,
          tier: activeRound.tier,
        });
        setActiveRound(null);
        setSafeTileHint(null);
        setShieldedTiles([]);
        confetti({ particleCount: 120, spread: 65, origin: { y: 0.55 }, colors: [accentColor, "#FFF9E0", "#B8860B", "#FFFFFF"], scalar: 0.9 });
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user!.telegramId) });
        fetchPasses();
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
    setBet((prev) => Math.max(minBet, Math.min(prev + delta, maxBet)));
  };
  const adjustMines = (delta: number) => {
    const total = gridSize * gridSize;
    setMinesCount((prev) => Math.max(1, Math.min(prev + delta, total - 2)));
  };

  // When mode/tier changes, reset bet to min
  useEffect(() => {
    if (!activeRound) {
      setBet(minBet);
    }
  }, [mode, selectedTier, minBet, activeRound]);

  // ── Loading ──
  if (userLoading) return <PageLoader rows={6} />;

  // ── Determine in-round currency label ──
  const roundCurrencyLabel = activeRound
    ? (activeRound.mode === "gc" && activeRound.tier !== "gold" ? "GC" : "TC")
    : currencyLabel;

  const roundAccent = activeRound?.tier
    ? GC_TIER_CONFIG[activeRound.tier]?.color ?? "#FFD700"
    : (activeRound?.mode === "tc" ? "#FFD700" : accentColor);

  // ── Render ──
  return (
    <div className="flex flex-col min-h-screen bg-[#050508] pb-28">
      {/* ── Header ── */}
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <p className="text-[9px] font-mono text-white/25 tracking-[0.25em] uppercase">Mines Terminal</p>
          <h1
            className="text-lg font-black tracking-tight"
            style={{ background: `linear-gradient(135deg,${accentColor},${accentColor}99)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}
          >
            {mode === "gc" ? `${GC_TIER_CONFIG[selectedTier].label.toUpperCase()} MODE` : "CLASSIC MODE"}
          </h1>
        </div>
        {activeRound && (
          <div className="flex flex-col items-end">
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-wider">Multiplier</span>
            <motion.span key={activeRound.multiplier} initial={{ scale: 1.2 }} animate={{ scale: 1 }} className="text-xl font-black" style={{ color: roundAccent }}>
              {activeRound.multiplier.toFixed(2)}×
            </motion.span>
          </div>
        )}
      </div>

      {/* ── Mode Selector (only when no active round) ── */}
      {!activeRound && (
        <div className="px-4 mb-3">
          {/* TC / GC toggle */}
          <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.06] mb-3">
            <button
              onClick={() => setMode("tc")}
              className={`flex-1 py-2.5 rounded-lg text-[11px] font-black transition-all flex items-center justify-center gap-1.5 ${
                mode === "tc" ? "bg-[#FFD700] text-black shadow-[0_0_12px_rgba(255,215,0,0.3)]" : "text-white/35 hover:text-white/60"
              }`}
            >
              <Sparkles size={13} />
              Classic (TC)
            </button>
            <button
              onClick={() => setMode("gc")}
              className={`flex-1 py-2.5 rounded-lg text-[11px] font-black transition-all flex items-center justify-center gap-1.5 ${
                mode === "gc" ? "bg-gradient-to-r from-[#CD7F32] via-[#C0C0C0] to-[#FFD700] text-black shadow-[0_0_12px_rgba(255,215,0,0.3)]" : "text-white/35 hover:text-white/60"
              }`}
            >
              <Crown size={13} />
              GC Mines
            </button>
          </div>

          {/* Tier selector (only in GC mode) */}
          <AnimatePresence>
            {mode === "gc" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex gap-2 mb-3">
                  {(["bronze", "silver", "gold"] as GcTierId[]).map((tierId) => {
                    const t = GC_TIER_CONFIG[tierId];
                    const TierIcon = t.icon;
                    const isSelected = selectedTier === tierId;
                    return (
                      <button
                        key={tierId}
                        onClick={() => setSelectedTier(tierId)}
                        className={`flex-1 py-3 px-2 rounded-xl border transition-all flex flex-col items-center gap-1 ${
                          isSelected
                            ? "border-opacity-40 bg-opacity-10"
                            : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
                        }`}
                        style={isSelected ? { borderColor: `${t.color}66`, backgroundColor: `${t.color}14` } : {}}
                      >
                        <TierIcon size={16} style={{ color: isSelected ? t.color : "rgba(255,255,255,0.3)" }} />
                        <span className="text-[10px] font-black" style={{ color: isSelected ? t.color : "rgba(255,255,255,0.4)" }}>
                          {t.label}
                        </span>
                        <span className="text-[8px] font-mono text-white/25">{t.desc}</span>
                        <span className="text-[8px] font-mono" style={{ color: isSelected ? t.color : "rgba(255,255,255,0.2)" }}>
                          {t.entryFeeTon} TON/round
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Round passes status & purchase */}
                <div className="p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] mb-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                        <Lock size={12} style={{ color: accentColor }} />
                      </div>
                      <div>
                        <p className="text-[11px] font-bold text-white">Round Passes</p>
                        <p className="text-[9px] font-mono text-white/30">
                          {passesForTier > 0 ? `${passesForTier} ${GC_TIER_CONFIG[selectedTier].label} rounds remaining` : "No passes — purchase to play"}
                        </p>
                      </div>
                    </div>
                    {passesForTier > 0 && (
                      <span className="text-sm font-black" style={{ color: accentColor }}>{passesForTier}</span>
                    )}
                  </div>

                  {/* Pack purchase buttons */}
                  <div className="flex gap-2">
                    {[1, 5, 10].map((packSize) => {
                      const tierConfig = GC_TIER_CONFIG[selectedTier];
                      let tonCost: string;
                      let savings = "";
                      if (packSize === 1) {
                        tonCost = tierConfig.entryFeeTon;
                      } else if (packSize === 5) {
                        const base = parseFloat(tierConfig.entryFeeTon);
                        tonCost = (base * 3.9).toFixed(2);
                        savings = "Save 22%";
                      } else {
                        const base = parseFloat(tierConfig.entryFeeTon);
                        tonCost = (base * 6.9).toFixed(2);
                        savings = "Save 31%";
                      }
                      return (
                        <button
                          key={packSize}
                          onClick={() => handleBuyPass(packSize)}
                          disabled={buyingPass}
                          className="flex-1 py-2.5 px-2 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-all flex flex-col items-center gap-0.5 disabled:opacity-40"
                        >
                          <span className="text-[11px] font-black text-white">{packSize}×</span>
                          <span className="text-[9px] font-mono" style={{ color: accentColor }}>{tonCost} TON</span>
                          {savings && <span className="text-[7px] font-bold text-[#00F5A0]">{savings}</span>}
                        </button>
                      );
                    })}
                  </div>
                  {buyingPass && (
                    <p className="text-[9px] font-mono text-white/30 text-center mt-2">Processing payment...</p>
                  )}
                </div>

                {/* Daily GC cap indicator */}
                {passesData && (
                  <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.05] mb-3">
                    <span className="text-[9px] font-mono text-white/30 uppercase">Daily GC from Mines</span>
                    <span className="text-[10px] font-mono" style={{ color: passesData.dailyGcRemaining > 0 ? "#00F5A0" : "#FF1744" }}>
                      {passesData.dailyGcFromMines.toLocaleString()} / {passesData.dailyGcCap.toLocaleString()} GC
                    </span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── Active power-up indicators (during round) ── */}
      <AnimatePresence>
        {activeRound && Object.keys(activeRound.activeGems).length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="px-4 mb-3 overflow-hidden">
            <div className="flex flex-wrap gap-2">
              {activeRound.activeGems.revenge_shield && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#00F5A0]/10 border border-[#00F5A0]/30">
                  <Shield size={12} className="text-[#00F5A0]" />
                  <span className="text-[10px] font-mono text-[#00F5A0] font-bold">SHIELD</span>
                </div>
              )}
              {typeof activeRound.activeGems.gem_magnet_left === "number" && activeRound.activeGems.gem_magnet_left > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#FFD700]/10 border border-[#FFD700]/30">
                  <Zap size={12} className="text-[#FFD700]" />
                  <span className="text-[10px] font-mono text-[#FFD700] font-bold">MAGNET ×{activeRound.activeGems.gem_magnet_left}</span>
                </div>
              )}
              {activeRound.activeGems.second_chance && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#FF9800]/10 border border-[#FF9800]/30">
                  <RefreshCw size={12} className="text-[#FF9800]" />
                  <span className="text-[10px] font-mono text-[#FF9800] font-bold">2ND CHANCE</span>
                </div>
              )}
              {safeTileHint !== null && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#00BFFF]/10 border border-[#00BFFF]/30">
                  <Eye size={12} className="text-[#00BFFF]" />
                  <span className="text-[10px] font-mono text-[#00BFFF] font-bold">SAFE: TILE {safeTileHint + 1}</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Controls (pre-round) ── */}
      <AnimatePresence mode="wait">
        {!activeRound ? (
          <motion.div key="controls" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="px-4 flex flex-col gap-3 mb-4">
            {/* Grid size + Mines count */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Grid Size</span>
                <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.06]">
                  {([3, 4, 5] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => { setGridSize(s); setMinesCount(Math.min(minesCount, s * s - 2)); }}
                      className={`flex-1 py-2 rounded-lg text-[11px] font-black transition-all ${
                        gridSize === s
                          ? "text-black shadow-[0_0_12px_rgba(255,215,0,0.3)]"
                          : "text-white/35 hover:text-white/60"
                      }`}
                      style={gridSize === s ? { backgroundColor: accentColor } : {}}
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
                  <span className="flex-1 text-center text-sm font-black" style={{ color: accentColor }}>{minesCount}</span>
                  <button onClick={() => adjustMines(1)} className="p-1.5 text-white/30 hover:text-white transition-colors"><ChevronUp size={15} /></button>
                </div>
              </div>
            </div>

            {/* Bet amount */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Bet Amount ({currencyLabel})</span>
                <span className="text-[9px] font-mono text-white/20">Balance: {userBalance.toLocaleString()} {currencyLabel}</span>
              </div>
              <div className="flex items-center bg-white/[0.03] border border-white/[0.06] rounded-xl px-2">
                <button onClick={() => adjustBet(-minBet)} className="p-3 text-white/30 hover:text-white transition-colors"><ChevronDown size={16} /></button>
                <div className="flex-1 flex flex-col items-center py-2">
                  <span className="text-base font-black text-white">{bet.toLocaleString()}</span>
                  <span className="text-[8px] font-mono text-white/20 uppercase">{currencyLabel} · Max {maxBet.toLocaleString()}</span>
                </div>
                <button onClick={() => adjustBet(minBet)} className="p-3 text-white/30 hover:text-white transition-colors"><ChevronUp size={16} /></button>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {[minBet, minBet * 2, minBet * 5, minBet * 10].filter((v) => v <= maxBet).map((v) => (
                  <button key={v} onClick={() => setBet(v)} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${bet === v ? "border-opacity-40 bg-opacity-15" : "border-white/10 text-white/30 hover:text-white/60"}`} style={bet === v ? { borderColor: `${accentColor}66`, backgroundColor: `${accentColor}26`, color: accentColor } : {}}>
                    {v >= 1000 ? `${v / 1000}K` : v}
                  </button>
                ))}
                <button onClick={() => setBet(Math.min(userBalance, maxBet))} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all ${bet === Math.min(userBalance, maxBet) ? "border-opacity-40 bg-opacity-15" : "border-white/10 text-white/30 hover:text-white/60"}`} style={bet === Math.min(userBalance, maxBet) ? { borderColor: `${accentColor}66`, backgroundColor: `${accentColor}26`, color: accentColor } : {}}>
                  MAX
                </button>
              </div>
            </div>

            {/* Power-up selection */}
            {availableMinesGems.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Power-ups</span>
                <div className="flex flex-col gap-2">
                  {availableMinesGems.map((gem) => {
                    const meta = GEM_META[gem.gemType];
                    if (!meta) return null;
                    const IconComp = meta.icon;
                    const isSelected = selectedGemIds.includes(gem.id);
                    return (
                      <button
                        key={gem.id}
                        onClick={() => toggleGem(gem.id)}
                        className="flex items-center gap-3 p-3 rounded-xl border transition-all"
                        style={isSelected ? { borderColor: `${meta.color}66`, backgroundColor: `${meta.color}14` } : { borderColor: "rgba(255,255,255,0.06)", backgroundColor: "rgba(255,255,255,0.02)" }}
                      >
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${meta.color}20` }}>
                          <IconComp size={16} style={{ color: meta.color }} />
                        </div>
                        <div className="flex-1 text-left">
                          <p className="text-[11px] font-bold text-white">{meta.name}</p>
                          <p className="text-[9px] font-mono text-white/30">{meta.desc} · ×{gem.usesRemaining} left</p>
                        </div>
                        <div className="w-5 h-5 rounded-md border flex items-center justify-center transition-all" style={isSelected ? { backgroundColor: meta.color, borderColor: "transparent" } : { borderColor: "rgba(255,255,255,0.2)" }}>
                          {isSelected && <Check size={12} className="text-black" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Next multiplier preview */}
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.05]">
              <span className="text-[10px] font-mono text-white/30 uppercase">First tile reward</span>
              <span className="text-[11px] font-black" style={{ color: accentColor }}>{nextMultiplier.toFixed(2)}×</span>
            </div>

            {/* Start button */}
            <motion.button
              onClick={handleStart}
              disabled={!canStart}
              whileTap={{ scale: 0.97 }}
              animate={canStart ? { boxShadow: [`0 0 20px ${accentColor}26`, `0 0 35px ${accentColor}4D`, `0 0 20px ${accentColor}26`] } : {}}
              transition={{ duration: 1.8, repeat: Infinity }}
              className="w-full py-4 rounded-2xl font-black text-sm tracking-widest uppercase disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: `linear-gradient(135deg,${accentColor},${accentColor}99)`, color: "#000" }}
            >
              <span className="inline-flex items-center gap-2">
                {starting ? (
                  <><RefreshCw size={14} className="animate-spin" /> Starting...</>
                ) : mode === "gc" && passesForTier === 0 ? (
                  <><Lock size={14} /> Purchase Round Pass</>
                ) : (
                  <><Sparkles size={14} /> {selectedGemIds.length > 0 ? `Start with ${selectedGemIds.length} Power-up${selectedGemIds.length > 1 ? "s" : ""}` : "Start Round"}</>
                )}
              </span>
            </motion.button>

            {/* Insufficient balance warning */}
            {userBalance < bet && (
              <p className="text-center text-[10px] font-mono text-[#FF1744]/70">
                Not enough {currencyLabel}. <button onClick={() => setLocation("/exchange")} className="underline" style={{ color: accentColor }}>Get more</button>
              </p>
            )}
            {mode === "gc" && passesForTier === 0 && (
              <p className="text-center text-[10px] font-mono text-white/30">
                Purchase a round pass above to play GC Mines
              </p>
            )}
          </motion.div>
        ) : (
          /* ── In-round controls ── */
          <motion.div key="in-round" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="px-4 flex flex-col gap-3 mb-4">
            <div className="flex items-center justify-between p-4 rounded-2xl border bg-opacity-[0.04]" style={{ borderColor: `${roundAccent}33`, backgroundColor: `${roundAccent}0A` }}>
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Next tile</span>
                <span className="text-xl font-black" style={{ color: roundAccent }}>{nextMultiplier.toFixed(2)}×</span>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Cash out now</span>
                <span className="text-xl font-black text-white">
                  {cashoutValue.toLocaleString()} {roundCurrencyLabel}
                  {activeRound.mode === "gc" && <span className="text-[10px] font-mono text-white/30 ml-1">→ GC</span>}
                </span>
              </div>
            </div>
            <motion.button
              onClick={handleCashout}
              disabled={!canCashout}
              whileTap={{ scale: 0.97 }}
              className="w-full py-4 rounded-2xl bg-white text-black font-black text-sm tracking-widest uppercase disabled:opacity-30 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(255,255,255,0.1)]"
            >
              {cashingOut ? (
                <span className="inline-flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Cashing out...</span>
              ) : (
                <span className="inline-flex items-center gap-2"><Trophy size={14} /> Cash Out {cashoutValue.toLocaleString()} {roundCurrencyLabel}</span>
              )}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Grid ── */}
      <div className="px-4 mb-4">
        <motion.div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${currentGridSize}, 1fr)` }}
        >
          {Array.from({ length: totalTiles }, (_, i) => {
            const isRevealed = activeRound?.revealed.includes(i) ?? false;
            const isLastHit = result?.hitTile === i;
            const isMineOnResult = result?.mines?.includes(i) ?? false;
            const isGhost = !activeRound && isMineOnResult && !isLastHit;
            const isShielded = shieldedTiles.includes(i);
            const isSafeHint = safeTileHint === i && !!activeRound && !isRevealed;
            return (
              <Tile
                key={i}
                index={i}
                isRevealed={isRevealed}
                isMine={isLastHit ? true : isGhost ? true : null}
                isLastHit={isLastHit && !isShielded}
                isShielded={isShielded}
                isGhost={isGhost}
                isSafeHint={isSafeHint}
                isLoading={loadingTile === i}
                disabled={!activeRound || isRevealed || isShielded || loadingTile !== null || cashingOut}
                onClick={() => handleReveal(i)}
                accentColor={roundAccent}
              />
            );
          })}
        </motion.div>
      </div>

      {/* ── Error banner ── */}
      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-4 mb-3 p-3 rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/[0.07] text-xs text-[#ffd6df] font-mono">
            {error}
            <button onClick={() => setError(null)} className="ml-2 text-white/40 hover:text-white"><X size={12} /></button>
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
            className={`mx-4 mb-4 p-5 rounded-2xl border flex flex-col gap-3 ${
              result.won
                ? "border-[#FFD700]/30 bg-[#FFD700]/[0.05]"
                : result.secondChance
                  ? "border-[#FF9800]/30 bg-[#FF9800]/[0.05]"
                  : "border-[#FF1744]/30 bg-[#FF1744]/[0.05]"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                result.won ? "bg-[#FFD700]/15" : result.secondChance ? "bg-[#FF9800]/15" : "bg-[#FF1744]/15"
              }`}>
                {result.won ? <Trophy size={20} className="text-[#FFD700]" /> :
                 result.secondChance ? <RefreshCw size={20} className="text-[#FF9800]" /> :
                 <Bomb size={20} className="text-[#FF1744]" />}
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-black text-white uppercase">
                  {result.won ? "Round Won!" : result.secondChance ? "Second Chance!" : "Boom! Hit a Mine"}
                </span>
                <span className="text-[11px] font-mono text-white/40">
                  {result.won && result.mode === "gc"
                    ? `+${(result.gcPayout ?? result.payout ?? 0).toLocaleString()} GC earned at ${result.multiplier?.toFixed(2)}×`
                    : result.won
                      ? `+${result.payout?.toLocaleString()} TC at ${result.multiplier?.toFixed(2)}×`
                      : result.secondChance
                        ? `Bet refunded: +${result.refund?.toLocaleString()} ${result.mode === "gc" && result.tier !== "gold" ? "GC" : "TC"}`
                        : "Better luck next time"
                  }
                </span>
              </div>
              {result.won && (
                <span className="ml-auto text-lg font-black" style={{ color: accentColor }}>{result.multiplier?.toFixed(2)}×</span>
              )}
            </div>

            {/* Power-up upsell after loss */}
            {!result.won && !result.secondChance && (
              <motion.button
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                onClick={() => setLocation("/exchange")}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-[#00F5A0]/30 bg-[#00F5A0]/[0.06] text-[#00F5A0] text-xs font-black uppercase tracking-widest"
              >
                <ShoppingBag size={13} />
                Get Power-ups
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── No power-ups CTA ── */}
      {!activeRound && availableMinesGems.length === 0 && (
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

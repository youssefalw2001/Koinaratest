import { useState } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDownUp, Gem, Zap, Shield, Package, RefreshCw, Crown, Lock, CheckCircle, ChevronRight, Wallet, Rocket, Flame, Star } from "lucide-react";
import { usePurchaseGem, useGetActiveGems, getGetActiveGemsQueryKey, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader, PageError } from "@/components/PageStatus";

type GemType = "starter_boost" | "big_swing" | "streak_saver" | "mystery_box" | "daily_refill" | "double_or_nothing";

interface GemDef {
  id: GemType;
  name: string;
  description: string;
  gcCost: number;
  uses: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; className?: string }>;
  color: string;
  vipOnly: boolean;
  badge?: string;
}

type ShopTab = "powerups" | "tc_packs";

interface TcPackDef {
  id: "micro" | "starter" | "pro" | "whale";
  name: string;
  price: string;
  tcAmount: number;
  bonus?: string;
  goal: string;
  accent: string;
  badge?: string;
  tonOnly?: boolean;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; className?: string }>;
}

const GEMS: GemDef[] = [
  {
    id: "starter_boost",
    name: "Starter Boost",
    description: "2× GC multiplier on your next 3 winning trades",
    gcCost: 1500, // Increased from 300
    uses: "3 uses",
    icon: Zap,
    color: "#00f0ff",
    vipOnly: false,
  },
  {
    id: "big_swing",
    name: "Big Swing",
    description: "5× GC multiplier on your next 2 winning trades",
    gcCost: 4000, // Increased from 750
    uses: "2 uses",
    icon: Gem,
    color: "#f5c518",
    vipOnly: false,
    badge: "HIGH VALUE",
  },
  {
    id: "streak_saver",
    name: "Streak Saver",
    description: "If your next trade loses, your TC bet is refunded automatically",
    gcCost: 2500, // Increased from 400
    uses: "1 use",
    icon: Shield,
    color: "#ff2d78",
    vipOnly: false,
  },
  {
    id: "mystery_box",
    name: "Mystery Box",
    description: "Random reward: 50–500 TC or a surprise powerup gem",
    gcCost: 1000, // Increased from 200
    uses: "Instant",
    icon: Package,
    color: "#a855f7",
    vipOnly: false,
    badge: "LUCKY",
  },
  {
    id: "daily_refill",
    name: "Daily Refill",
    description: "Reset today's ad cap + bonus 1,000 TC instantly",
    gcCost: 3000, // Increased from 500
    uses: "Instant",
    icon: RefreshCw,
    color: "#f5c518",
    vipOnly: true,
    badge: "VIP ONLY",
  },
];

const TC_PACKS: TcPackDef[] = [
  {
    id: "micro",
    name: "Micro Pack",
    price: "$0.99",
    tcAmount: 7000,
    goal: "Emergency Refill · high volume, low friction.",
    accent: "#63D3FF",
    badge: "FAST REFILL",
    icon: Zap,
  },
  {
    id: "starter",
    name: "Starter Pack",
    price: "$2.99",
    tcAmount: 30000,
    bonus: "Includes 1 Power-up",
    goal: "First real conversion with a pity item to keep momentum.",
    accent: "#B794F4",
    badge: "BEST START",
    icon: Star,
  },
  {
    id: "pro",
    name: "Pro Pack",
    price: "$9.99",
    tcAmount: 150000,
    goal: "High extraction. Whale-feeling balance for a full day.",
    accent: "#FFD166",
    badge: "MOST POPULAR",
    icon: Rocket,
  },
  {
    id: "whale",
    name: "Whale Pack",
    price: "$49.99",
    tcAmount: 1000000,
    bonus: "Includes VIP bonus perks",
    goal: "Maximum extraction focus for GCC (Saudi/UAE) heavy users.",
    accent: "#00F5A0",
    badge: "TON ONLY",
    tonOnly: true,
    icon: Flame,
  },
];

export default function Shop() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [activeTab, setActiveTab] = useState<ShopTab>("powerups");
  const [confirming, setConfirming] = useState<GemType | null>(null);
  const [lastResult, setLastResult] = useState<{ name: string; mysteryReward?: { type: string; amount?: number; gem?: string } | null } | null>(null);

  const purchaseMutation = usePurchaseGem();

  const { data: activeGems, isLoading: gemsLoading, isError: gemsError, refetch: refetchGems } = useGetActiveGems(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") },
  });

  const safeActiveGems = Array.isArray(activeGems) ? activeGems : [];

  const getActiveCount = (gemType: GemType) =>
    safeActiveGems.filter((g) => g.gemType === gemType && g.usesRemaining > 0)
      .reduce((sum, g) => sum + g.usesRemaining, 0);

  const handleBuy = async (gem: GemDef) => {
    if (!user) return;
    if (confirming !== gem.id) {
      setConfirming(gem.id);
      return;
    }
    setConfirming(null);
    try {
      const result = await purchaseMutation.mutateAsync({
        data: { telegramId: user.telegramId, gemType: gem.id },
      });
      setLastResult({ name: gem.name, mysteryReward: result.mysteryReward as { type: string; amount?: number; gem?: string } | null });
      queryClient.invalidateQueries({ queryKey: getGetActiveGemsQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      setTimeout(() => setLastResult(null), 3500);
    } catch {
      // silent
    }
  };

  if (gemsLoading) return <PageLoader rows={4} />;
  if (gemsError) return <PageError message="Could not load shop items" onRetry={refetchGems} />;

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      {/* Toast */}
      <AnimatePresence>
        {lastResult && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -50 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl border border-[#00f0ff]/40 bg-black/90 backdrop-blur shadow-[0_0_30px_rgba(0,240,255,0.3)] min-w-[220px]"
          >
            <CheckCircle size={18} className="text-[#00f0ff] shrink-0 drop-shadow-[0_0_8px_#00f0ff]" />
            <div>
              <div className="font-mono text-sm font-black text-[#00f0ff]">{lastResult.name} Activated!</div>
              {lastResult.mysteryReward?.type === "tc" && (
                <div className="font-mono text-[10px] text-white/50">+{lastResult.mysteryReward.amount} TC awarded</div>
              )}
              {lastResult.mysteryReward?.type === "gem" && (
                <div className="font-mono text-[10px] text-white/50">Bonus gem: {lastResult.mysteryReward.gem}</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Gem size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
        <span className="font-mono text-xs text-white/60 tracking-[0.18em] uppercase">Elite Shop</span>
      </div>
      <h1 className="text-2xl font-black text-white mb-1 tracking-[0.08em]">{activeTab === "powerups" ? "Powerups" : "TC Packs"}</h1>
      <p className="font-mono text-xs text-white/40 mb-2">
        {activeTab === "powerups"
          ? "Spend Gold Coins to amplify your GC gains. Active gems auto-apply to trades."
          : "Instant Trade Credit refills to get users back in the game immediately."}
      </p>

      {/* Tabs */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          onClick={() => setActiveTab("powerups")}
          className={`py-2.5 rounded-xl border font-mono text-[11px] font-black tracking-widest transition-all ${activeTab === "powerups" ? "text-[#FFD700] border-[#FFD700]/60 bg-[#FFD700]/10 shadow-[0_0_16px_rgba(255,215,0,0.15)]" : "text-white/40 border-white/10 bg-white/[0.02]"}`}
        >
          POWERUPS
        </button>
        <button
          onClick={() => setActiveTab("tc_packs")}
          className={`py-2.5 rounded-xl border font-mono text-[11px] font-black tracking-widest transition-all ${activeTab === "tc_packs" ? "text-[#63D3FF] border-[#63D3FF]/60 bg-[#63D3FF]/10 shadow-[0_0_16px_rgba(99,211,255,0.15)]" : "text-white/40 border-white/10 bg-white/[0.02]"}`}
        >
          TC PACKS
        </button>
      </div>

      {/* Balance */}
      {user && (
        <div className="app-card flex items-center gap-2 mb-4 p-3">
          <span className="text-sm">🪙</span>
          <span className="font-mono text-sm font-bold text-[#FFD700]">{(user.goldCoins ?? 0).toLocaleString()} GC</span>
          <span className="font-mono text-[10px] text-white/30 ml-auto">available balance</span>
        </div>
      )}

      {/* Active Gems Summary */}
      {activeTab === "powerups" && safeActiveGems.length > 0 && (
        <div className="mb-5 p-3 rounded-xl border border-[#f5c518]/30 bg-[#f5c518]/5">
          <div className="font-mono text-[10px] text-[#f5c518] tracking-widest uppercase mb-2">Active Powerups</div>
          <div className="flex flex-wrap gap-2">
            {safeActiveGems.map((g) => (
              <div key={g.id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#f5c518]/10 border border-[#f5c518]/30">
                <Gem size={10} className="text-[#f5c518]" />
                <span className="font-mono text-[10px] text-[#f5c518] capitalize">{g.gemType.replace(/_/g, " ")}</span>
                <span className="font-mono text-[9px] text-white/50">×{g.usesRemaining}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "powerups" ? (
      <div className="space-y-3">
        {GEMS.map((gem) => {
          const Icon = gem.icon;
          const locked = gem.vipOnly && !vip;
          const canAfford = (user?.goldCoins ?? 0) >= gem.gcCost;
          const activeCount = getActiveCount(gem.id);
          const isConfirming = confirming === gem.id;

          return (
            <motion.div
              key={gem.id}
              layout
              className="p-4 rounded-2xl border-2 relative overflow-hidden"
              style={{
                borderColor: locked ? "rgba(255,255,255,0.08)" : `${gem.color}40`,
                background: locked ? "rgba(255,255,255,0.02)" : `${gem.color}08`,
                boxShadow: locked ? "none" : `0 0 15px ${gem.color}18`,
              }}
            >
              {gem.badge && !locked && (
                <div
                  className="absolute top-3 right-3 font-mono text-[8px] font-black px-1.5 py-0.5 rounded"
                  style={{ background: `${gem.color}25`, color: gem.color, border: `1px solid ${gem.color}40` }}
                >
                  {gem.badge}
                </div>
              )}
              {activeCount > 0 && (
                <div className="absolute top-3 left-3 w-5 h-5 rounded-full flex items-center justify-center font-mono text-[9px] font-black bg-[#f5c518] text-black">
                  {activeCount}
                </div>
              )}

              <div className="flex items-start gap-3">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                  style={{
                    background: locked ? "rgba(255,255,255,0.05)" : `${gem.color}18`,
                    border: `1px solid ${locked ? "rgba(255,255,255,0.08)" : gem.color + "40"}`,
                  }}
                >
                  {locked ? (
                    <Lock size={16} className="text-white/20" />
                  ) : (
                    <Icon size={18} style={{ color: gem.color }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-sm font-black ${locked ? "text-white/30" : "text-white"}`}>
                      {gem.name}
                    </span>
                    {gem.vipOnly && (
                      <Crown size={10} className="text-[#f5c518] shrink-0" />
                    )}
                  </div>
                  <div className={`font-mono text-[10px] mt-0.5 leading-relaxed ${locked ? "text-white/20" : "text-white/50"}`}>
                    {gem.description}
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px]">🪙</span>
                      <span className={`font-mono text-xs font-bold ${locked ? "text-white/20" : "text-[#FFD700]"}`}>
                        {gem.gcCost === 0 ? "FREE" : `${gem.gcCost} GC`}
                      </span>
                    </div>
                    <span className={`font-mono text-[9px] ${locked ? "text-white/15" : "text-white/30"}`}>{gem.uses}</span>
                  </div>
                </div>
              </div>

              {!locked && (
                <div className="mt-3">
                  {isConfirming ? (
                    <div className="flex gap-2">
                      <motion.button
                        whileTap={{ scale: 0.97 }}
                        onClick={() => handleBuy(gem)}
                        disabled={!canAfford || purchaseMutation.isPending}
                        className="flex-1 py-2 rounded-xl font-mono text-xs font-black border-2 transition-all disabled:opacity-40"
                        style={{
                          borderColor: gem.color,
                          background: `${gem.color}15`,
                          color: gem.color,
                        }}
                      >
                        {purchaseMutation.isPending ? "PROCESSING..." : "CONFIRM PURCHASE"}
                      </motion.button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="px-4 py-2 rounded-xl font-mono text-xs font-black bg-white/5 text-white/40"
                      >
                        CANCEL
                      </button>
                    </div>
                  ) : (
                    <motion.button
                      whileTap={{ scale: 0.98 }}
                      onClick={() => handleBuy(gem)}
                      className="w-full py-2.5 rounded-xl font-mono text-xs font-black transition-all flex items-center justify-center gap-2"
                      style={{
                        background: canAfford ? `${gem.color}15` : "rgba(255,255,255,0.03)",
                        color: canAfford ? gem.color : "rgba(255,255,255,0.2)",
                        border: `1px solid ${canAfford ? gem.color + "40" : "rgba(255,255,255,0.05)"}`,
                      }}
                    >
                      {canAfford ? "PURCHASE" : "INSUFFICIENT GC"}
                    </motion.button>
                  )}
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
      ) : (
        <div className="space-y-3">
          {TC_PACKS.map((pack) => {
            const Icon = pack.icon;
            return (
              <motion.div
                key={pack.id}
                layout
                className="relative p-4 rounded-2xl border overflow-hidden"
                style={{
                  borderColor: `${pack.accent}66`,
                  background: `linear-gradient(160deg, ${pack.accent}18 0%, rgba(0,0,0,0.35) 70%)`,
                  boxShadow: `0 0 26px ${pack.accent}26`,
                }}
              >
                {pack.badge && (
                  <div
                    className="absolute top-3 right-3 font-mono text-[8px] font-black px-2 py-0.5 rounded"
                    style={{ background: `${pack.accent}28`, color: pack.accent, border: `1px solid ${pack.accent}60` }}
                  >
                    {pack.badge}
                  </div>
                )}

                <div className="flex items-start gap-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: `${pack.accent}20`, border: `1px solid ${pack.accent}60` }}
                  >
                    <Icon size={18} style={{ color: pack.accent }} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm font-black text-white">{pack.name}</span>
                      <span className="font-mono text-xs font-black" style={{ color: pack.accent }}>
                        {pack.price}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="font-mono text-[11px] font-black text-white">{pack.tcAmount.toLocaleString()} TC</span>
                      {pack.bonus && (
                        <span className="px-2 py-0.5 rounded-md font-mono text-[9px] text-[#FFD700] border border-[#FFD700]/30 bg-[#FFD700]/10">
                          {pack.bonus}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-white/55 mt-2 leading-relaxed">
                      {pack.goal}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        className="py-2 rounded-xl font-mono text-[10px] font-black border"
                        style={{ borderColor: `${pack.accent}66`, color: pack.accent, background: `${pack.accent}14` }}
                      >
                        BUY NOW
                      </button>
                      <Link href="/wallet" className="py-2 rounded-xl font-mono text-[10px] font-black border border-white/10 text-white/60 bg-black/20 flex items-center justify-center gap-1.5">
                        <Wallet size={12} />
                        FUND
                      </Link>
                    </div>
                    {pack.tonOnly && (
                      <div className="mt-2 font-mono text-[9px] text-[#00F5A0] tracking-widest uppercase">TON NETWORK ONLY</div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

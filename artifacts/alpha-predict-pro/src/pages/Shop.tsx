import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gem, Zap, Shield, Package, RefreshCw, Crown, Lock, CheckCircle, ChevronRight } from "lucide-react";
import { usePurchaseGem, useGetActiveGems, getGetActiveGemsQueryKey, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";

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

const GEMS: GemDef[] = [
  {
    id: "starter_boost",
    name: "Starter Boost",
    description: "2× GC multiplier on your next 3 winning trades",
    gcCost: 300,
    uses: "3 uses",
    icon: Zap,
    color: "#00f0ff",
    vipOnly: false,
  },
  {
    id: "big_swing",
    name: "Big Swing",
    description: "5× GC multiplier on your next 2 winning trades",
    gcCost: 750,
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
    gcCost: 400,
    uses: "1 use",
    icon: Shield,
    color: "#ff2d78",
    vipOnly: false,
  },
  {
    id: "mystery_box",
    name: "Mystery Box",
    description: "Random reward: 50–500 TC or a surprise powerup gem",
    gcCost: 200,
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
    gcCost: 500,
    uses: "Instant",
    icon: RefreshCw,
    color: "#f5c518",
    vipOnly: true,
    badge: "VIP ONLY",
  },
];

export default function Shop() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [confirming, setConfirming] = useState<GemType | null>(null);
  const [lastResult, setLastResult] = useState<{ name: string; mysteryReward?: { type: string; amount?: number; gem?: string } | null } | null>(null);

  const purchaseMutation = usePurchaseGem();

  const { data: activeGems } = useGetActiveGems(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") },
  });

  const getActiveCount = (gemType: GemType) => {
    if (!activeGems) return 0;
    return activeGems.filter((g) => g.gemType === gemType && g.usesRemaining > 0)
      .reduce((sum, g) => sum + g.usesRemaining, 0);
  };

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
        <span className="font-mono text-xs text-white/60 tracking-[0.18em] uppercase">Gem Shop</span>
      </div>
      <h1 className="text-2xl font-black text-white mb-1 tracking-[0.08em]">Powerups</h1>
      <p className="font-mono text-xs text-white/40 mb-2">Spend Gold Coins to amplify your GC gains. Active gems auto-apply to trades.</p>

      {/* Balance */}
      {user && (
        <div className="app-card flex items-center gap-2 mb-6 p-3">
          <span className="text-sm">🪙</span>
          <span className="font-mono text-sm font-bold text-[#FFD700]">{(user.goldCoins ?? 0).toLocaleString()} GC</span>
          <span className="font-mono text-[10px] text-white/30 ml-auto">available balance</span>
        </div>
      )}

      {/* Active Gems Summary */}
      {activeGems && activeGems.length > 0 && (
        <div className="mb-5 p-3 rounded-xl border border-[#f5c518]/30 bg-[#f5c518]/5">
          <div className="font-mono text-[10px] text-[#f5c518] tracking-widest uppercase mb-2">Active Powerups</div>
          <div className="flex flex-wrap gap-2">
            {activeGems.map((g) => (
              <div key={g.id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#f5c518]/10 border border-[#f5c518]/30">
                <Gem size={10} className="text-[#f5c518]" />
                <span className="font-mono text-[10px] text-[#f5c518] capitalize">{g.gemType.replace(/_/g, " ")}</span>
                <span className="font-mono text-[9px] text-white/50">×{g.usesRemaining}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gem Grid */}
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
                          color: "#000",
                          background: gem.color,
                        }}
                      >
                        {purchaseMutation.isPending ? "BUYING..." : `CONFIRM — ${gem.gcCost} GC`}
                      </motion.button>
                      <button
                        onClick={() => setConfirming(null)}
                        className="px-3 py-2 rounded-xl font-mono text-xs text-white/40 border border-white/10"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={() => handleBuy(gem)}
                      disabled={!canAfford || purchaseMutation.isPending}
                      className="w-full flex items-center justify-between py-2.5 px-3 rounded-xl font-mono text-xs font-black border transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        borderColor: canAfford ? `${gem.color}60` : "rgba(255,255,255,0.1)",
                        color: canAfford ? gem.color : "rgba(255,255,255,0.2)",
                        background: canAfford ? `${gem.color}10` : "transparent",
                      }}
                    >
                      <span>{canAfford ? "BUY POWERUP" : "NOT ENOUGH GC"}</span>
                      {canAfford && <ChevronRight size={12} />}
                    </motion.button>
                  )}
                </div>
              )}

              {locked && (
                <div className="mt-3 flex items-center gap-2 py-2 px-3 rounded-xl border border-[#f5c518]/20 bg-[#f5c518]/5">
                  <Crown size={10} className="text-[#f5c518]" />
                  <span className="font-mono text-[10px] text-[#f5c518]/70">VIP required — activate in Wallet</span>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Double or Nothing info */}
      <div className="mt-4 p-4 rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 mb-1">
          <Zap size={12} className="text-[#ff2d78]" />
          <span className="font-mono text-xs font-black text-white">Double or Nothing</span>
          <span className="font-mono text-[9px] text-white/30 ml-auto">FREE · On loss</span>
        </div>
        <p className="font-mono text-[10px] text-white/40 leading-relaxed">
          After a losing trade, a "Double or Nothing" button appears in the result screen. One free rematch at 2× stakes — win or leave empty-handed.
        </p>
      </div>
    </div>
  );
}

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gift, ExternalLink, Lock, Crown, Star, TrendingUp, Activity, Zap, BookOpen, MessageCircle, Users, BarChart2, Layers } from "lucide-react";
import { useListQuests, useClaimQuest, getListQuestsQueryKey, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

const iconMap: Record<string, React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>> = {
  "trending-up": TrendingUp,
  "bar-chart-2": BarChart2,
  "activity": Activity,
  "layers": Layers,
  "zap": Zap,
  "coins": Star,
  "crown": Crown,
  "shield": Star,
  "twitter": ExternalLink,
  "message-circle": MessageCircle,
  "users": Users,
  "book-open": BookOpen,
  "star": Star,
};

const categoryColors: Record<string, string> = {
  "Exchange": "#00f0ff",
  "Social": "#ff2d78",
  "Education": "#a855f7",
};

export default function Earn() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const { data: quests, isLoading } = useListQuests();
  const claimQuest = useClaimQuest();
  const [claimedIds, setClaimedIds] = useState<Set<number>>(new Set());
  const [lastClaim, setLastClaim] = useState<{ tc: number; id: number } | null>(null);

  const handleClaim = async (questId: number, externalUrl: string) => {
    if (!user) return;
    window.open(externalUrl, "_blank");
    try {
      const result = await claimQuest.mutateAsync({ id: questId, data: { telegramId: user.telegramId } });
      setClaimedIds(prev => new Set([...prev, questId]));
      setLastClaim({ tc: result.tcAwarded, id: questId });
      setTimeout(() => setLastClaim(null), 3000);
      queryClient.invalidateQueries({ queryKey: getListQuestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {}
  };

  const freeQuests = quests?.filter(q => !q.isVipOnly) ?? [];
  const vipQuests = quests?.filter(q => q.isVipOnly) ?? [];

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-2">
        <Gift size={16} className="text-[#00f0ff] drop-shadow-[0_0_6px_#00f0ff]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Earn Center</span>
      </div>
      <h1 className="font-mono text-2xl font-black text-white mb-1">Koinara Quests</h1>
      <p className="font-mono text-xs text-white/40 mb-6">Complete missions. Earn Trade Credits. Trade to win Gold Coins.</p>

      {/* VIP Banner */}
      {user && !user.isVip && (
        <div
          className="flex items-center gap-3 p-3 rounded-xl border-2 border-[#f5c518]/50 bg-[#f5c518]/8 mb-6"
          style={{ boxShadow: "0 0 20px rgba(245,197,24,0.15)" }}
        >
          <Crown size={20} className="text-[#f5c518] shrink-0 drop-shadow-[0_0_6px_#f5c518]" />
          <div>
            <div className="font-mono text-xs font-bold text-[#f5c518]">VIP earns 2x more on every win</div>
            <div className="font-mono text-[10px] text-white/50">Unlock exclusive high-value quests</div>
          </div>
        </div>
      )}

      {/* Claim notification */}
      <AnimatePresence>
        {lastClaim && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-4 left-4 right-4 z-50 max-w-[420px] mx-auto"
          >
            <div
              className="flex items-center gap-3 p-3 rounded-xl border border-[#00f0ff]/50 bg-[#00f0ff]/15"
              style={{ boxShadow: "0 0 20px rgba(0,240,255,0.3)" }}
            >
              <span className="text-base">🔵</span>
              <span className="font-mono text-sm text-[#00f0ff] font-bold">+{lastClaim.tc} Trade Credits Claimed!</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      )}

      {/* Free Quests */}
      {freeQuests.length > 0 && (
        <>
          <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Free Quests</div>
          <div className="space-y-3 mb-6">
            {freeQuests.map((quest) => {
              const Icon = iconMap[quest.iconName] ?? Star;
              const isClaimed = claimedIds.has(quest.id);
              const catColor = categoryColors[quest.category] ?? "#00f0ff";
              return (
                <motion.div
                  key={quest.id}
                  whileTap={{ scale: 0.98 }}
                  className={`relative flex items-center gap-3 p-4 rounded-xl border ${isClaimed ? "border-white/10 opacity-60" : "border-white/15"} bg-white/[0.03]`}
                >
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center border border-white/10 bg-white/5">
                    <Icon size={18} style={{ color: catColor }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-sm font-bold text-white truncate">{quest.title}</span>
                      <span
                        className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border shrink-0"
                        style={{ color: catColor, borderColor: `${catColor}40`, background: `${catColor}10` }}
                      >
                        {quest.category}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-white/40 truncate">{quest.description}</div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs">🔵</span>
                      <span className="font-mono text-sm font-black text-[#00f0ff]">+{quest.reward} TC</span>
                    </div>
                    <button
                      onClick={() => handleClaim(quest.id, quest.externalUrl)}
                      disabled={isClaimed || claimQuest.isPending}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded font-mono text-xs font-bold border transition-all duration-150 ${
                        isClaimed
                          ? "border-white/10 text-white/30 bg-transparent cursor-default"
                          : "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/10 hover:bg-[#00f0ff]/20"
                      }`}
                      data-testid={`btn-claim-${quest.id}`}
                    >
                      {isClaimed ? "Claimed" : <><span>Claim</span><ExternalLink size={9} /></>}
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {/* VIP Quests */}
      {vipQuests.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <Crown size={12} className="text-[#f5c518]" />
            <span className="font-mono text-[10px] text-[#f5c518] tracking-widest uppercase">VIP Exclusive</span>
          </div>
          <div className="space-y-3">
            {vipQuests.map((quest) => {
              const Icon = iconMap[quest.iconName] ?? Crown;
              const isClaimed = claimedIds.has(quest.id);
              const isLocked = !user?.isVip;
              return (
                <motion.div
                  key={quest.id}
                  className={`relative flex items-center gap-3 p-4 rounded-xl border-2 ${
                    isLocked ? "border-[#f5c518]/25 opacity-70" : "border-[#f5c518]/50"
                  } bg-[#f5c518]/5`}
                  style={{ boxShadow: isLocked ? "none" : "0 0 15px rgba(245,197,24,0.12)" }}
                >
                  {isLocked && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/60 z-10">
                      <Lock size={20} className="text-[#f5c518]" />
                    </div>
                  )}
                  <div className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center border border-[#f5c518]/30 bg-[#f5c518]/10">
                    <Icon size={18} className="text-[#f5c518]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono text-sm font-bold text-white">{quest.title}</span>
                      <Crown size={10} className="text-[#f5c518]" />
                    </div>
                    <div className="font-mono text-[11px] text-white/40">{quest.description}</div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs">🔵</span>
                      <span className="font-mono text-sm font-black text-[#f5c518]">+{quest.reward} TC</span>
                    </div>
                    <button
                      onClick={() => !isLocked && !isClaimed && handleClaim(quest.id, quest.externalUrl)}
                      disabled={isLocked || isClaimed}
                      className="flex items-center gap-1 px-3 py-1.5 rounded font-mono text-xs font-bold border border-[#f5c518] text-[#f5c518] bg-[#f5c518]/10 disabled:opacity-50"
                      data-testid={`btn-claim-vip-${quest.id}`}
                    >
                      {isClaimed ? "Claimed" : isLocked ? <Lock size={10} /> : <><span>Claim</span><ExternalLink size={9} /></>}
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

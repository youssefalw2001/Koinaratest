import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gift, ExternalLink, Lock, Crown, Star, TrendingUp, Activity, Zap, BookOpen, MessageCircle, Users, BarChart2, Layers, Play, CheckCircle2, Tv } from "lucide-react";
import { useListQuests, useClaimQuest, useWatchAd, getListQuestsQueryKey, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";

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

const AD_DURATION = 15;

export default function Earn() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const { data: quests, isLoading } = useListQuests();
  const claimQuest = useClaimQuest();
  const watchAdMutation = useWatchAd();

  const [claimedIds, setClaimedIds] = useState<Set<number>>(new Set());
  const [lastClaim, setLastClaim] = useState<{ tc: number; id: number } | null>(null);

  const [adState, setAdState] = useState<"idle" | "watching" | "done">("idle");
  const [adCountdown, setAdCountdown] = useState(AD_DURATION);
  const [adResult, setAdResult] = useState<{ tc: number; adsLeft: number } | null>(null);
  const [adsWatchedToday, setAdsWatchedToday] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const vip = isVipActive(user);
  const adTcReward = vip ? 100 : 80;
  const adDailyCap = vip ? 25 : 5;
  const adsRemaining = adsWatchedToday !== null ? Math.max(0, adDailyCap - adsWatchedToday) : null;
  const adProgress = adsWatchedToday !== null ? (adsWatchedToday / adDailyCap) * 100 : 0;
  const adsCapped = adsRemaining === 0;

  const loadAdStatus = useCallback(async () => {
    if (!user) return;
    try {
      const resp = await fetch(`/api/rewards/ad-status/${user.telegramId}`);
      if (resp.ok) {
        const data = await resp.json();
        setAdsWatchedToday(data.adsWatchedToday ?? 0);
      }
    } catch {}
  }, [user]);

  useEffect(() => {
    loadAdStatus();
  }, [loadAdStatus]);

  const handleStartAd = () => {
    if (adState !== "idle") return;
    setAdState("watching");
    setAdCountdown(AD_DURATION);
    countdownRef.current = setInterval(() => {
      setAdCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          handleAdComplete();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleAdComplete = async () => {
    if (!user) return;
    setAdState("done");
    try {
      const result = await watchAdMutation.mutateAsync({ data: { telegramId: user.telegramId } });
      const adsLeft = result.dailyCap - result.adsWatchedToday;
      setAdResult({ tc: result.tcAwarded, adsLeft });
      setAdsWatchedToday(result.adsWatchedToday);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      setTimeout(() => {
        setAdResult(null);
        setAdState("idle");
      }, 3500);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "";
      if (msg.includes("cap")) {
        setAdsWatchedToday(adDailyCap);
      }
      setAdState("idle");
    }
  };

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

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
      {user && !isVipActive(user) && (
        <div
          className="flex items-center gap-3 p-3 rounded-xl border-2 border-[#f5c518]/50 bg-[#f5c518]/8 mb-6"
          style={{ boxShadow: "0 0 20px rgba(245,197,24,0.15)" }}
        >
          <Crown size={20} className="text-[#f5c518] shrink-0 drop-shadow-[0_0_6px_#f5c518]" />
          <div>
            <div className="font-mono text-xs font-bold text-[#f5c518]">VIP unlocks 3,000 GC daily cap</div>
            <div className="font-mono text-[10px] text-white/50">Unlock exclusive high-value quests + 25 ads/day</div>
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

      {/* Ad Reward Section */}
      <div className="mb-6">
        <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Watch & Earn</div>
        <div
          className="p-4 rounded-2xl border-2 relative overflow-hidden"
          style={{
            borderColor: vip ? "#f5c518" : "#ff2d78",
            background: vip ? "rgba(245,197,24,0.04)" : "rgba(255,45,120,0.04)",
            boxShadow: vip ? "0 0 20px rgba(245,197,24,0.12)" : "0 0 20px rgba(255,45,120,0.12)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Tv size={16} style={{ color: vip ? "#f5c518" : "#ff2d78" }} />
              <span className="font-mono text-sm font-black text-white">Watch Ad</span>
              {vip && <span className="font-mono text-[9px] text-[#f5c518] border border-[#f5c518]/40 bg-[#f5c518]/10 px-1.5 py-0.5 rounded">VIP</span>}
            </div>
            <div className="flex items-center gap-1">
              <span className="text-xs">🔵</span>
              <span className="font-mono text-sm font-black" style={{ color: vip ? "#f5c518" : "#ff2d78" }}>+{adTcReward} TC</span>
            </div>
          </div>

          {/* Daily ad count progress */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="font-mono text-[10px] text-white/40">
                {adsRemaining !== null
                  ? adsCapped
                    ? "Daily cap reached — come back tomorrow"
                    : `${adsRemaining} of ${adDailyCap} ads remaining today`
                  : `Up to ${adDailyCap} ads/day · 15s each · Instant TC credit`
                }
              </div>
              {adsWatchedToday !== null && (
                <span className="font-mono text-[9px] text-white/30 tabular-nums">
                  {adsWatchedToday}/{adDailyCap}
                </span>
              )}
            </div>
            {adsWatchedToday !== null && (
              <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(adProgress, 100)}%`,
                    background: adsCapped
                      ? "linear-gradient(90deg, #ff2d78, #ff6060)"
                      : vip
                        ? "linear-gradient(90deg, #f5c518, #ff9900)"
                        : "linear-gradient(90deg, #ff2d78, #ff6060)",
                  }}
                />
              </div>
            )}
          </div>

          {adState === "idle" && (
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleStartAd}
              disabled={adsCapped}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-mono text-sm font-black border-2 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                borderColor: vip ? "#f5c518" : "#ff2d78",
                color: vip ? "#f5c518" : "#ff2d78",
                background: vip ? "rgba(245,197,24,0.12)" : "rgba(255,45,120,0.12)",
                boxShadow: vip ? "0 0 15px rgba(245,197,24,0.2)" : "0 0 15px rgba(255,45,120,0.2)",
              }}
              data-testid="btn-watch-ad"
            >
              <Play size={14} />
              {adsCapped ? "CAP REACHED — COME BACK TOMORROW" : `WATCH AD — EARN ${adTcReward} TC`}
            </motion.button>
          )}

          {adState === "watching" && (
            <div className="flex flex-col items-center py-2">
              <div className="relative w-16 h-16 flex items-center justify-center mb-2">
                <svg className="absolute inset-0" viewBox="0 0 64 64">
                  <circle
                    cx="32" cy="32" r="28"
                    fill="none"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="4"
                  />
                  <circle
                    cx="32" cy="32" r="28"
                    fill="none"
                    stroke={vip ? "#f5c518" : "#ff2d78"}
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={175.9}
                    strokeDashoffset={175.9 * (adCountdown / AD_DURATION)}
                    transform="rotate(-90 32 32)"
                    style={{ transition: "stroke-dashoffset 1s linear", filter: `drop-shadow(0 0 4px ${vip ? "#f5c518" : "#ff2d78"})` }}
                  />
                </svg>
                <span className="font-mono text-xl font-black text-white z-10">{adCountdown}</span>
              </div>
              <div className="font-mono text-xs text-white/50">Watching ad...</div>
            </div>
          )}

          {adState === "done" && (
            <AnimatePresence>
              {adResult && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center py-2"
                >
                  <CheckCircle2 size={28} className="text-[#00f0ff] mb-1 drop-shadow-[0_0_8px_#00f0ff]" />
                  <div className="font-mono text-lg font-black text-[#00f0ff]">+{adResult.tc} TC Earned!</div>
                  <div className="font-mono text-[10px] text-white/40">{adResult.adsLeft} ads remaining today</div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>

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
              const isLocked = !isVipActive(user);
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

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gift, ExternalLink, Lock, Crown, Star, TrendingUp, Activity, Zap, BookOpen, MessageCircle, Users, BarChart2, Layers, Play, CheckCircle2, Tv, Video, Send, CheckCircle, AlertCircle } from "lucide-react";
import { useListQuests, useClaimQuest, useWatchAd, useGetAdStatus, useSubmitContent, useGetContentSubmissions, getGetAdStatusQueryKey, getListQuestsQueryKey, getGetUserQueryKey, getGetContentSubmissionsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader, PageError } from "@/components/PageStatus";

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

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "x", label: "X (Twitter)" },
] as const;

const CONTENT_TIERS = [
  { views: "1K", gc: "500 GC" },
  { views: "10K", gc: "6,000 GC" },
  { views: "50K", gc: "40,000 GC" },
  { views: "100K", gc: "100,000 GC" },
  { views: "1M", gc: "1,500,000 GC" },
];

export default function Earn() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const { data: quests, isLoading, isError: questsError, refetch: refetchQuests } = useListQuests();
  const claimQuest = useClaimQuest();
  const watchAdMutation = useWatchAd();

  const [activeTab, setActiveTab] = useState<"quests" | "content">("quests");
  const [claimedIds, setClaimedIds] = useState<Set<number>>(new Set());
  const [lastClaim, setLastClaim] = useState<{ tc: number; id: number } | null>(null);

  const [adState, setAdState] = useState<"idle" | "watching" | "done">("idle");
  const [adCountdown, setAdCountdown] = useState(AD_DURATION);
  const [adResult, setAdResult] = useState<{ tc: number; adsLeft: number } | null>(null);
  const [showAdToast, setShowAdToast] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [contentUrl, setContentUrl] = useState("");
  const [contentPlatform, setContentPlatform] = useState<"tiktok" | "instagram" | "youtube" | "x">("tiktok");
  const [contentSubmitFeedback, setContentSubmitFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const submitContentMutation = useSubmitContent();
  const { data: submissions, refetch: refetchSubmissions } = useGetContentSubmissions(user?.telegramId ?? "", {
    query: { enabled: !!user && isVipActive(user), queryKey: getGetContentSubmissionsQueryKey(user?.telegramId ?? "") },
  });

  const { data: adStatusData, refetch: refetchAdStatus } = useGetAdStatus(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetAdStatusQueryKey(user?.telegramId ?? "") }
  });

  const vip = isVipActive(user);
  const adTcReward = vip ? 100 : 80;
  const adDailyCap = adStatusData?.dailyCap ?? (vip ? 25 : 5);
  const adsWatchedToday = adStatusData?.adsWatchedToday ?? null;
  const adsRemaining = adsWatchedToday !== null ? Math.max(0, adDailyCap - adsWatchedToday) : null;
  const adProgress = adsWatchedToday !== null ? (adsWatchedToday / adDailyCap) * 100 : 0;
  const adsCapped = adsRemaining === 0;

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
      refetchAdStatus();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      // Show floating toast
      setShowAdToast(true);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        setShowAdToast(false);
        setAdResult(null);
        setAdState("idle");
      }, 3500);
    } catch {
      refetchAdStatus();
      setAdState("idle");
    }
  };

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
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

  const handleSubmitContent = async () => {
    if (!user || !contentUrl.trim()) return;
    try {
      await submitContentMutation.mutateAsync({
        data: { telegramId: user.telegramId, platform: contentPlatform, url: contentUrl.trim() },
      });
      setContentUrl("");
      setContentSubmitFeedback({ ok: true, msg: "Submitted! Our team reviews within 48hrs." });
      refetchSubmissions();
      setTimeout(() => setContentSubmitFeedback(null), 4000);
    } catch {
      setContentSubmitFeedback({ ok: false, msg: "Invalid URL or submission failed." });
      setTimeout(() => setContentSubmitFeedback(null), 3000);
    }
  };

  const freeQuests = quests?.filter(q => !q.isVipOnly) ?? [];
  const vipQuests = quests?.filter(q => q.isVipOnly) ?? [];

  if (isLoading) return <PageLoader rows={4} />;
  if (questsError) return <PageError message="Could not load quests" onRetry={refetchQuests} />;

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      {/* Floating ad reward toast — fixed-position, slides in from top */}
      <AnimatePresence>
        {showAdToast && adResult && (
          <motion.div
            initial={{ opacity: 0, y: -60 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -60 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-5 py-3 rounded-2xl border border-[#00f0ff]/40 bg-black/90 backdrop-blur shadow-[0_0_30px_rgba(0,240,255,0.3)]"
          >
            <CheckCircle2 size={20} className="text-[#00f0ff] drop-shadow-[0_0_8px_#00f0ff] shrink-0" />
            <div>
              <div className="font-mono text-sm font-black text-[#00f0ff]">+{adResult.tc} TC Earned!</div>
              <div className="font-mono text-[10px] text-white/40">{adResult.adsLeft} ads remaining today</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2 mb-2">
        <Gift size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
        <span className="font-mono text-xs text-white/60 tracking-[0.18em] uppercase">Earn Center</span>
      </div>
      <h1 className="text-2xl font-black text-white mb-1">Koinara Quests</h1>
      <p className="font-mono text-xs text-white/40 mb-4">Complete missions. Earn Trade Credits. Trade to win Gold Coins.</p>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-xl border border-white/10 bg-white/[0.02] mb-5">
        <button
          onClick={() => setActiveTab("quests")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-mono text-xs font-bold transition-all ${
            activeTab === "quests"
              ? "bg-[#00f0ff]/15 text-[#00f0ff] border border-[#00f0ff]/30"
              : "text-white/40 border border-transparent"
          }`}
        >
          <Gift size={11} />
          Quests
        </button>
        <button
          onClick={() => setActiveTab("content")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-mono text-xs font-bold transition-all relative ${
            activeTab === "content"
              ? "bg-[#f5c518]/15 text-[#f5c518] border border-[#f5c518]/30"
              : "text-white/40 border border-transparent"
          }`}
        >
          <Video size={11} />
          Content
          {!vip && <Crown size={8} className="text-[#f5c518] ml-0.5" />}
        </button>
      </div>

      {/* VIP Banner (quests tab only) */}
      {activeTab === "quests" && user && !isVipActive(user) && (
        <div
          className="flex items-center gap-3 p-3 rounded-xl border-2 border-[#f5c518]/50 bg-[#f5c518]/8 mb-6"
          style={{ boxShadow: "0 0 20px rgba(245,197,24,0.15)" }}
        >
          <Crown size={20} className="text-[#f5c518] shrink-0 drop-shadow-[0_0_6px_#f5c518]" />
          <div>
            <div className="font-mono text-xs font-bold text-[#f5c518]">VIP unlocks 6,000 GC daily cap</div>
            <div className="font-mono text-[10px] text-white/50">Unlock exclusive high-value quests + 25 ads/day</div>
          </div>
        </div>
      )}

      {/* Content Rewards Tab */}
      {activeTab === "content" && (
        <div>
          {!vip ? (
            <div className="relative">
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-black/80 backdrop-blur-sm border border-[#f5c518]/30">
                <Crown size={32} className="text-[#f5c518] drop-shadow-[0_0_15px_#f5c518] mb-3" />
                <div className="font-mono text-sm font-black text-[#f5c518] mb-1">VIP Required</div>
                <div className="font-mono text-[11px] text-white/50 text-center px-6">
                  Content rewards are exclusive to VIP members. Activate VIP in Wallet.
                </div>
              </div>
              <div className="opacity-20 pointer-events-none p-4 rounded-2xl border border-white/10 h-64" />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Reward tiers */}
              <div className="p-4 rounded-2xl border border-[#f5c518]/30 bg-[#f5c518]/5">
                <div className="font-mono text-[10px] text-[#f5c518] tracking-widest uppercase mb-3">Reward Tiers · #KoinTrades</div>
                <div className="space-y-1.5">
                  {CONTENT_TIERS.map(({ views, gc }, idx) => (
                    <div key={idx} className="flex items-center justify-between px-2 py-1.5 rounded-lg" style={{ background: "rgba(245,197,24,0.05)" }}>
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-[#f5c518]" />
                        <span className="font-mono text-xs text-white/60">{views} views</span>
                      </div>
                      <span className="font-mono text-xs font-bold text-[#f5c518]">{gc}</span>
                    </div>
                  ))}
                </div>
                <div className="font-mono text-[9px] text-white/30 mt-2">Cap: $1,000/week maximum per creator</div>
              </div>

              {/* Submit form */}
              <div className="p-4 rounded-2xl border border-white/15 bg-white/[0.02]">
                <div className="font-mono text-xs font-black text-white mb-3">Submit Content</div>

                <div className="mb-3">
                  <div className="font-mono text-[10px] text-white/40 mb-1.5 uppercase tracking-wider">Platform</div>
                  <div className="flex gap-1.5">
                    {PLATFORMS.map(({ id, label }) => (
                      <button
                        key={id}
                        onClick={() => setContentPlatform(id)}
                        className={`flex-1 py-1.5 rounded-lg font-mono text-[10px] font-bold border transition-all ${
                          contentPlatform === id
                            ? "border-[#00f0ff] bg-[#00f0ff]/15 text-[#00f0ff]"
                            : "border-white/10 text-white/30"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mb-3">
                  <div className="font-mono text-[10px] text-white/40 mb-1.5 uppercase tracking-wider">Post URL</div>
                  <input
                    type="url"
                    value={contentUrl}
                    onChange={(e) => setContentUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full bg-white/5 border border-white/15 rounded-xl px-3 py-2.5 font-mono text-xs text-white placeholder-white/20 outline-none focus:border-[#00f0ff]/50"
                  />
                  <div className="font-mono text-[9px] text-white/25 mt-1">Must include hashtag #KoinTrades in your post</div>
                </div>

                {contentSubmitFeedback && (
                  <div className={`flex items-center gap-2 p-2.5 rounded-xl mb-3 border ${
                    contentSubmitFeedback.ok ? "border-[#00f0ff]/30 bg-[#00f0ff]/8 text-[#00f0ff]" : "border-[#ff2d78]/30 bg-[#ff2d78]/8 text-[#ff2d78]"
                  }`}>
                    {contentSubmitFeedback.ok ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                    <span className="font-mono text-[10px]">{contentSubmitFeedback.msg}</span>
                  </div>
                )}

                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleSubmitContent}
                  disabled={!contentUrl.trim() || submitContentMutation.isPending}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-mono text-sm font-black border-2 transition-all disabled:opacity-40"
                  style={{ borderColor: "#00f0ff", color: "#00f0ff", background: "rgba(0,240,255,0.1)" }}
                >
                  <Send size={14} />
                  {submitContentMutation.isPending ? "SUBMITTING..." : "SUBMIT FOR REVIEW"}
                </motion.button>

                <div className="font-mono text-[9px] text-white/25 mt-2 text-center">
                  Verification is manual — our team reviews within 48hrs
                </div>
              </div>

              {/* Submissions list */}
              {submissions && submissions.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-2">Your Submissions</div>
                  <div className="space-y-2">
                    {submissions.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-3 p-3 rounded-xl border border-white/10 bg-white/[0.02]">
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-[10px] text-white/60 truncate">{sub.url}</div>
                          <div className="font-mono text-[9px] text-white/30 capitalize">{sub.platform} · {new Date(sub.createdAt).toLocaleDateString()}</div>
                        </div>
                        <div
                          className={`font-mono text-[9px] font-bold px-2 py-1 rounded-full border ${
                            sub.status === "paid"
                              ? "text-[#00f0ff] border-[#00f0ff]/30 bg-[#00f0ff]/10"
                              : sub.status === "verified"
                              ? "text-[#f5c518] border-[#f5c518]/30 bg-[#f5c518]/10"
                              : "text-white/40 border-white/15 bg-white/5"
                          }`}
                        >
                          {sub.status === "paid" ? "✓ PAID" : sub.status === "verified" ? "VERIFIED" : "PENDING"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
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

      {/* Quests Tab Content */}
      {activeTab === "quests" && <>

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
            <div className="flex flex-col items-center py-3">
              <CheckCircle2 size={24} className="text-[#00f0ff] opacity-50" />
            </div>
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

      </>}
    </div>
  );
}

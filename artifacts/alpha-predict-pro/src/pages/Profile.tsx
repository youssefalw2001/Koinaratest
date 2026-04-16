import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { User, Crown, Share2, TrendingUp, Target, Award, Flame, CheckCircle, Copy } from "lucide-react";
import { useGetUserStats, useClaimDailyReward, getGetUserQueryKey, getGetUserStatsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

export default function Profile() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [dailyClaimed, setDailyClaimed] = useState(false);
  const [dailyResult, setDailyResult] = useState<{ tc: number; streak: number; isVip: boolean } | null>(null);

  const { data: stats, isLoading: statsLoading } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetUserStatsQueryKey(user?.telegramId ?? "") }
  });

  const claimDaily = useClaimDailyReward();

  const handleDailyClaim = async () => {
    if (!user || dailyClaimed) return;
    try {
      const result = await claimDaily.mutateAsync({ data: { telegramId: user.telegramId } });
      setDailyClaimed(true);
      setDailyResult({ tc: result.tcAwarded, streak: result.streak, isVip: result.isVipBonus });
      setTimeout(() => setDailyResult(null), 4000);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetUserStatsQueryKey(user.telegramId) });
    } catch {}
  };

  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";

  const handleCopyReferral = async () => {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const winRate = stats ? Math.round(stats.winRate * 100) : 0;

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-6">
        <User size={16} className="text-[#00f0ff] drop-shadow-[0_0_6px_#00f0ff]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Profile</span>
      </div>

      {/* Daily Reward Toast */}
      <AnimatePresence>
        {dailyResult && (
          <motion.div
            initial={{ opacity: 0, y: -30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            className="fixed top-4 left-4 right-4 z-50 max-w-[420px] mx-auto"
          >
            <div
              className="p-4 rounded-2xl border-2 text-center"
              style={{
                borderColor: dailyResult.isVip ? "#f5c518" : "#00f0ff",
                background: dailyResult.isVip ? "rgba(245,197,24,0.18)" : "rgba(0,240,255,0.18)",
                boxShadow: dailyResult.isVip ? "0 0 40px rgba(245,197,24,0.5)" : "0 0 40px rgba(0,240,255,0.5)",
              }}
            >
              <div className="font-mono text-4xl font-black mb-1" style={{ color: dailyResult.isVip ? "#f5c518" : "#00f0ff" }}>
                +{dailyResult.tc} 🔵 TC
              </div>
              <div className="font-mono text-xs text-white/70">
                {dailyResult.isVip ? "VIP BONUS — " : ""}Day {dailyResult.streak} streak!
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* User Info */}
      {user && (
        <div className="flex items-center gap-4 mb-6 p-4 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center font-mono text-2xl font-black shrink-0"
            style={{
              background: user.isVip ? "rgba(245,197,24,0.15)" : "rgba(0,240,255,0.1)",
              border: `2px solid ${user.isVip ? "#f5c518" : "#00f0ff"}`,
              boxShadow: user.isVip ? "0 0 15px rgba(245,197,24,0.4)" : "0 0 15px rgba(0,240,255,0.3)",
              color: user.isVip ? "#f5c518" : "#00f0ff",
            }}
          >
            {(user.firstName ?? user.username ?? "K").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-black text-white">
                {user.firstName ?? user.username ?? "Koin Trader"}
              </span>
              {user.isVip && <Crown size={14} className="text-[#f5c518]" />}
            </div>
            {user.username && (
              <span className="font-mono text-xs text-white/40">@{user.username}</span>
            )}
            <div className="flex items-center gap-3 mt-1">
              <div className="flex items-center gap-1">
                <span className="text-xs">🔵</span>
                <span className="font-mono text-xs font-bold text-[#00f0ff]">{(user.tradeCredits ?? 0).toLocaleString()} TC</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs">🪙</span>
                <span className="font-mono text-xs font-bold text-[#f5c518]">{(user.goldCoins ?? 0).toLocaleString()} GC</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Daily Reward Button */}
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={handleDailyClaim}
        disabled={dailyClaimed || claimDaily.isPending}
        className={`w-full flex items-center justify-between p-4 rounded-xl border-2 mb-4 transition-all ${
          dailyClaimed
            ? "border-white/10 bg-white/5 opacity-50"
            : user?.isVip
            ? "border-[#f5c518] bg-[#f5c518]/10"
            : "border-[#00f0ff] bg-[#00f0ff]/10"
        }`}
        style={!dailyClaimed ? {
          boxShadow: user?.isVip ? "0 0 20px rgba(245,197,24,0.25)" : "0 0 20px rgba(0,240,255,0.25)"
        } : {}}
        data-testid="btn-claim-daily"
      >
        <div className="flex items-center gap-3">
          <Flame
            size={20}
            style={{
              color: dailyClaimed ? "rgba(255,255,255,0.3)" : user?.isVip ? "#f5c518" : "#00f0ff",
              filter: dailyClaimed ? "none" : `drop-shadow(0 0 6px ${user?.isVip ? "#f5c518" : "#00f0ff"})`,
            }}
          />
          <div className="text-left">
            <div className="font-mono text-sm font-black text-white">
              {dailyClaimed ? "Daily Reward Claimed" : "Claim Daily Reward"}
            </div>
            <div className="font-mono text-[10px] text-white/40">
              {user?.isVip ? "VIP 2x Bonus Active" : `Streak: ${user?.loginStreak ?? 0} days`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {dailyClaimed ? (
            <CheckCircle size={16} className="text-white/30" />
          ) : (
            <span className="font-mono text-sm font-black" style={{ color: user?.isVip ? "#f5c518" : "#00f0ff" }}>
              {user?.isVip ? "150+" : "100+"} TC
            </span>
          )}
        </div>
      </motion.button>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {[
          { label: "Win Rate", value: statsLoading ? "..." : `${winRate}%`, icon: TrendingUp, color: winRate >= 50 ? "#00f0ff" : "#ff2d78" },
          { label: "Total Trades", value: statsLoading ? "..." : (stats?.totalPredictions ?? 0), icon: Target, color: "#00f0ff" },
          { label: "GC Earned", value: statsLoading ? "..." : `${stats?.totalGcEarned ?? 0}`, icon: Award, color: "#f5c518" },
          { label: "Referrals", value: statsLoading ? "..." : (stats?.referralCount ?? 0), icon: Share2, color: "#ff2d78" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="p-3 rounded-xl border border-white/10 bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-2">
              <Icon size={12} style={{ color }} />
              <span className="font-mono text-[10px] text-white/40 tracking-wider uppercase">{label}</span>
            </div>
            <div className="font-mono text-lg font-black text-white">{String(value)}</div>
          </div>
        ))}
      </div>

      {/* Login Streak */}
      <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Flame size={14} className="text-[#f5c518]" />
          <span className="font-mono text-xs text-white/50 tracking-wider uppercase">Login Streak</span>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 7 }).map((_, i) => {
            const active = i < (user?.loginStreak ?? 0);
            return (
              <div
                key={i}
                className="flex-1 h-8 rounded"
                style={{
                  background: active ? "linear-gradient(135deg, #f5c518, #ff2d78)" : "rgba(255,255,255,0.05)",
                  border: active ? "1px solid rgba(245,197,24,0.5)" : "1px solid rgba(255,255,255,0.1)",
                }}
              />
            );
          })}
        </div>
        <div className="font-mono text-[10px] text-white/30 mt-2">
          {user?.loginStreak ?? 0} day streak — {user?.isVip ? "VIP 2x bonus active" : "Go VIP for 2x"}
        </div>
      </div>

      {/* Referral */}
      <div className="p-4 rounded-xl border border-[#ff2d78]/30 bg-[#ff2d78]/5 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Share2 size={14} className="text-[#ff2d78]" />
          <span className="font-mono text-xs text-[#ff2d78] tracking-wider uppercase">Referral</span>
        </div>
        <div className="font-mono text-[10px] text-white/40 mb-3">
          Invite friends — earn TC commission on their winnings
        </div>
        <div className="flex gap-2">
          <div className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 font-mono text-[11px] text-white/50 truncate">
            {referralLink || "Loading..."}
          </div>
          <button
            onClick={handleCopyReferral}
            className="flex items-center gap-1 px-3 py-2 rounded border border-[#ff2d78] font-mono text-xs text-[#ff2d78] bg-[#ff2d78]/10 shrink-0"
            data-testid="btn-copy-referral"
          >
            {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {/* VIP CTA for free users */}
      {user && !user.isVip && (
        <div
          className="p-4 rounded-2xl border-2 border-[#f5c518]/60 bg-[#f5c518]/5 text-center"
          style={{ boxShadow: "0 0 25px rgba(245,197,24,0.15)" }}
        >
          <Crown size={24} className="text-[#f5c518] mx-auto mb-2 drop-shadow-[0_0_10px_#f5c518]" />
          <div className="font-mono text-sm font-black text-[#f5c518] mb-1">VIP EARNS 2x MORE</div>
          <div className="font-mono text-[10px] text-white/40 mb-2">
            2x GC wins · 3,000 GC daily cap · Withdrawal access
          </div>
          <div className="font-mono text-xs text-white/40">
            Only 500 TC — activate in Wallet
          </div>
        </div>
      )}
    </div>
  );
}

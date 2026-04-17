import { useState } from "react";
import { motion } from "framer-motion";
import { User, Crown, Share2, TrendingUp, Target, Award, Flame, CheckCircle, Copy, Rocket, Star, Lock, ExternalLink, Clock } from "lucide-react";
import { useGetUserStats, getGetUserStatsQueryKey, useGetReferralStats, getGetReferralStatsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const DAY7_MILESTONES = [
  { day: 1, label: "Welcome Pack", reward: "500 TC bonus", icon: Rocket },
  { day: 2, label: "Daily Streak", reward: "+50 TC daily", icon: Flame },
  { day: 3, label: "First Win", reward: "+100 GC", icon: Target },
  { day: 4, label: "VIP Preview", reward: "Trial eligible", icon: Crown },
  { day: 5, label: "Gold Earner", reward: "+150 TC", icon: TrendingUp },
  { day: 6, label: "GC Milestone", reward: "+200 TC", icon: Award },
  { day: 7, label: "Survivor Bonus", reward: "3K TC + VIP Trial", icon: Star },
];

export default function Profile() {
  const { user } = useTelegram();
  const [copied, setCopied] = useState(false);

  const { data: stats, isLoading: statsLoading } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetUserStatsQueryKey(user?.telegramId ?? "") }
  });

  const { data: referralData } = useGetReferralStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetReferralStatsQueryKey(user?.telegramId ?? "") }
  });

  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";

  const handleCopyReferral = async () => {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShareTelegram = () => {
    const text = encodeURIComponent("Join me on Koinara — trade BTC predictions, earn real USDT! 🚀");
    const url = encodeURIComponent(referralLink);
    const shareUrl = `https://t.me/share/url?url=${url}&text=${text}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tg = (window as any).Telegram?.WebApp;
    if (typeof window !== "undefined" && tg) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, "_blank");
    }
  };

  const winRate = stats ? Math.round(stats.winRate * 100) : 0;
  const loginStreak = user?.loginStreak ?? 0;
  const registrationDayIndex = user?.registrationDate
    ? Math.floor((Date.now() - new Date(user.registrationDate).getTime()) / 86400000)
    : 0;
  const currentDay = Math.min(registrationDayIndex + 1, 7);
  const vip = isVipActive(user);

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-6">
        <User size={16} className="text-[#00f0ff] drop-shadow-[0_0_6px_#00f0ff]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Profile</span>
      </div>

      {/* User Info */}
      {user && (
        <div className="flex items-center gap-4 mb-6 p-4 rounded-2xl border border-white/10 bg-white/[0.02]">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center font-mono text-2xl font-black shrink-0"
            style={{
              background: vip ? "rgba(245,197,24,0.15)" : "rgba(0,240,255,0.1)",
              border: `2px solid ${vip ? "#f5c518" : "#00f0ff"}`,
              boxShadow: vip ? "0 0 15px rgba(245,197,24,0.4)" : "0 0 15px rgba(0,240,255,0.3)",
              color: vip ? "#f5c518" : "#00f0ff",
            }}
          >
            {(user.firstName ?? user.username ?? "K").charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-black text-white">
                {user.firstName ?? user.username ?? "Koin Trader"}
              </span>
              {vip && <Crown size={14} className="text-[#f5c518]" />}
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

      {/* Daily Streak Info — reward is auto-credited on app open */}
      <div
        className="w-full flex items-center justify-between p-4 rounded-xl border-2 mb-4"
        style={{
          borderColor: vip ? "rgba(245,197,24,0.4)" : "rgba(0,240,255,0.3)",
          background: vip ? "rgba(245,197,24,0.06)" : "rgba(0,240,255,0.06)",
        }}
      >
        <div className="flex items-center gap-3">
          <Flame
            size={20}
            style={{
              color: vip ? "#f5c518" : "#00f0ff",
              filter: `drop-shadow(0 0 6px ${vip ? "#f5c518" : "#00f0ff"})`,
            }}
          />
          <div className="text-left">
            <div className="font-mono text-sm font-black text-white">Daily Reward</div>
            <div className="font-mono text-[10px] text-white/40">
              Auto-credited on login · {vip ? "VIP Active" : `${loginStreak}-day streak`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <CheckCircle size={16} style={{ color: vip ? "#f5c518" : "#00f0ff" }} />
          <span className="font-mono text-sm font-black" style={{ color: vip ? "#f5c518" : "#00f0ff" }}>
            {vip ? `${150 + loginStreak * 15}` : `${100 + loginStreak * 10}`} TC/day
          </span>
        </div>
      </div>

      {/* Week 1 Journey Tracker */}
      <div
        className="p-4 rounded-2xl border-2 mb-4"
        style={{
          borderColor: "rgba(245,197,24,0.3)",
          background: "rgba(245,197,24,0.03)",
        }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Rocket size={14} className="text-[#f5c518]" />
          <span className="font-mono text-xs font-black text-[#f5c518] tracking-wider uppercase">Week 1 Journey</span>
          <span className="font-mono text-[10px] text-white/30 ml-auto">Day {currentDay}/7</span>
        </div>
        {/* Day icons strip */}
        <div className="grid grid-cols-7 gap-1 mb-2">
          {DAY7_MILESTONES.map(({ day, icon: Icon }) => {
            const isComplete = currentDay >= day;
            const isCurrent = currentDay === day - 1;
            const isLocked = currentDay < day - 1;
            return (
              <div key={day} className="flex flex-col items-center gap-1">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center relative"
                  style={{
                    background: isComplete
                      ? "linear-gradient(135deg, #f5c518, #ff2d78)"
                      : isCurrent
                      ? "rgba(245,197,24,0.15)"
                      : "rgba(255,255,255,0.05)",
                    border: isComplete
                      ? "1px solid rgba(245,197,24,0.6)"
                      : isCurrent
                      ? "1px solid rgba(245,197,24,0.4)"
                      : "1px solid rgba(255,255,255,0.08)",
                    boxShadow: isComplete ? "0 0 8px rgba(245,197,24,0.4)" : isCurrent ? "0 0 12px rgba(245,197,24,0.3)" : "none",
                  }}
                >
                  {isLocked ? (
                    <Lock size={10} className="text-white/20" />
                  ) : (
                    <Icon
                      size={12}
                      style={{ color: isComplete ? "#000" : isCurrent ? "#f5c518" : "rgba(255,255,255,0.3)" }}
                    />
                  )}
                  {day === 7 && isComplete && (
                    <div className="absolute -top-1 -right-1 text-[8px]">🎉</div>
                  )}
                </div>
                <div className="font-mono text-[7px] text-center leading-tight" style={{
                  color: isComplete ? "#f5c518" : isCurrent ? "rgba(245,197,24,0.6)" : "rgba(255,255,255,0.2)"
                }}>
                  D{day}
                </div>
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-white/8 overflow-hidden mb-3">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${(currentDay / 7) * 100}%` }}
            className="h-full rounded-full"
            style={{ background: "linear-gradient(90deg, #f5c518, #ff2d78)" }}
          />
        </div>

        {/* Milestone reward labels — all 7 days listed */}
        <div className="space-y-1">
          {DAY7_MILESTONES.map(({ day, label, reward, icon: Icon }) => {
            const isComplete = currentDay >= day;
            const isCurrent = currentDay === day - 1;
            return (
              <div
                key={day}
                className="flex items-center gap-2 px-2 py-1 rounded-lg"
                style={{
                  background: isComplete
                    ? "rgba(245,197,24,0.08)"
                    : isCurrent
                    ? "rgba(245,197,24,0.04)"
                    : "transparent",
                  border: isCurrent ? "1px solid rgba(245,197,24,0.2)" : "1px solid transparent",
                }}
              >
                <div
                  className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                  style={{
                    background: isComplete ? "linear-gradient(135deg,#f5c518,#ff2d78)" : "rgba(255,255,255,0.05)",
                  }}
                >
                  <Icon size={8} style={{ color: isComplete ? "#000" : "rgba(255,255,255,0.25)" }} />
                </div>
                <div className="font-mono text-[9px] text-white/40 shrink-0 w-5">D{day}</div>
                <div
                  className="font-mono text-[9px] flex-1"
                  style={{ color: isComplete ? "#f5c518" : isCurrent ? "rgba(245,197,24,0.7)" : "rgba(255,255,255,0.25)" }}
                >
                  {label}
                </div>
                <div
                  className="font-mono text-[9px] shrink-0"
                  style={{ color: isComplete ? "#ff2d78" : "rgba(255,255,255,0.2)" }}
                >
                  {reward}
                </div>
                {isComplete && <CheckCircle size={8} style={{ color: "#f5c518", flexShrink: 0 }} />}
              </div>
            );
          })}
        </div>

        <div className="font-mono text-[10px] text-white/30 mt-2">
          {currentDay < 7
            ? "Complete daily trades to unlock each milestone"
            : "🏆 Week 1 Complete — Survivor Bonus unlocked!"}
        </div>
      </div>

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
            const active = i < loginStreak;
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
          {loginStreak} day streak — {vip ? "VIP bonus active" : "Go VIP for higher caps"}
        </div>
      </div>

      {/* Referral — enhanced section */}
      <div className="p-4 rounded-2xl border-2 border-[#ff2d78]/40 bg-[#ff2d78]/5 mb-4" style={{ boxShadow: "0 0 20px rgba(255,45,120,0.1)" }}>
        <div className="flex items-center gap-2 mb-3">
          <Share2 size={14} className="text-[#ff2d78]" />
          <span className="font-mono text-xs font-black text-[#ff2d78] tracking-wider uppercase">Invite & Earn</span>
          {referralData && (
            <div className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#ff2d78]/15 border border-[#ff2d78]/30">
              <span className="font-mono text-[9px] text-[#ff2d78] font-bold">{referralData.referralCount} referrals</span>
            </div>
          )}
        </div>

        {/* Rewards summary */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="p-2 rounded-xl border border-[#ff2d78]/20 bg-[#ff2d78]/5 text-center">
            <div className="font-mono text-[9px] text-white/40 mb-0.5">You earn (per referral)</div>
            <div className="font-mono text-sm font-black text-[#ff2d78]">200 GC</div>
            <div className="font-mono text-[8px] text-white/30">after their 1st trade</div>
          </div>
          <div className="p-2 rounded-xl border border-[#ff2d78]/20 bg-[#ff2d78]/5 text-center">
            <div className="font-mono text-[9px] text-white/40 mb-0.5">Friend earns</div>
            <div className="font-mono text-sm font-black text-[#00f0ff]">500 TC</div>
            <div className="font-mono text-[8px] text-white/30">welcome bonus</div>
          </div>
        </div>

        {/* Pending GC earnings */}
        {referralData && referralData.pendingGc > 0 && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl border border-[#f5c518]/30 bg-[#f5c518]/8 mb-3">
            <Clock size={10} className="text-[#f5c518] shrink-0" />
            <div className="flex-1">
              <span className="font-mono text-xs font-bold text-[#f5c518]">{referralData.pendingGc} GC pending</span>
              {referralData.unlocksAt && (
                <div className="font-mono text-[9px] text-white/30">
                  Unlocks {new Date(referralData.unlocksAt).toLocaleDateString()}
                </div>
              )}
            </div>
            {referralData.isUnlocked && (
              <span className="font-mono text-[9px] text-[#00f0ff] border border-[#00f0ff]/30 px-1.5 py-0.5 rounded">READY</span>
            )}
          </div>
        )}

        {/* VIP commission info */}
        <div className="flex items-start gap-2 p-2.5 rounded-xl border mb-3"
          style={{
            borderColor: vip ? "rgba(245,197,24,0.3)" : "rgba(255,255,255,0.08)",
            background: vip ? "rgba(245,197,24,0.06)" : "rgba(255,255,255,0.02)",
          }}
        >
          <Crown size={10} className={`shrink-0 mt-0.5 ${vip ? "text-[#f5c518]" : "text-white/20"}`} />
          <div>
            <div className={`font-mono text-[10px] font-bold mb-0.5 ${vip ? "text-[#f5c518]" : "text-white/25"}`}>
              VIP Commission
            </div>
            <div className={`font-mono text-[9px] leading-relaxed ${vip ? "text-white/50" : "text-white/20"}`}>
              20% of every purchase + 10% of every withdrawal your referrals make — in GC, for life.
            </div>
            {!vip && (
              <div className="font-mono text-[8px] text-[#f5c518]/60 mt-0.5">Requires VIP — activate in Wallet</div>
            )}
          </div>
        </div>

        {/* Referral link */}
        <div className="flex gap-2">
          <div className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 font-mono text-[10px] text-white/40 truncate">
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
          <button
            onClick={handleShareTelegram}
            className="flex items-center gap-1 px-3 py-2 rounded border border-white/20 font-mono text-xs text-white/50 bg-white/5 shrink-0"
            data-testid="btn-share-telegram"
          >
            <ExternalLink size={12} />
            Share
          </button>
        </div>

        <div className="font-mono text-[9px] text-white/25 mt-2">
          Daily cap: 50 new referrals counted · GC locked 14 days before withdrawal
        </div>
      </div>

      {/* VIP CTA for free users */}
      {user && !vip && (
        <div
          className="p-4 rounded-2xl border-2 border-[#f5c518]/60 bg-[#f5c518]/5 text-center"
          style={{ boxShadow: "0 0 25px rgba(245,197,24,0.15)" }}
        >
          <Crown size={24} className="text-[#f5c518] mx-auto mb-2 drop-shadow-[0_0_10px_#f5c518]" />
          <div className="font-mono text-sm font-black text-[#f5c518] mb-1">UNLOCK VIP BENEFITS</div>
          <div className="font-mono text-[10px] text-white/40 mb-2">
            6,000 GC daily cap · Bet up to 5,000 TC · Withdrawals
          </div>
          <div className="font-mono text-xs text-white/40">
            Only 500 TC — activate in Wallet
          </div>
        </div>
      )}
    </div>
  );
}

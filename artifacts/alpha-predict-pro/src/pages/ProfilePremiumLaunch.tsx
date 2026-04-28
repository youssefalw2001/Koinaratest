import { useState } from "react";
import { motion } from "framer-motion";
import { Award, BookOpen, CheckCircle, Copy, Crown, Flame, Rocket, Share2, ShieldCheck, Sparkles, Star, Target, Trophy, User, Zap } from "lucide-react";
import { Link } from "wouter";
import { useGetReferralStats, getGetReferralStatsQueryKey, useGetUserStats, getGetUserStatsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader, PageError } from "@/components/PageStatus";

const LEVELS = [
  { level: 1, name: "Rookie", xp: 0, trade: "7K", mines: "5K", perk: "Base earning limits" },
  { level: 2, name: "Trader", xp: 1500, trade: "8K", mines: "6K", perk: "+1 daily reward chest" },
  { level: 3, name: "Pro", xp: 5000, trade: "9K", mines: "7K", perk: "Creator proof badge" },
  { level: 4, name: "Elite", xp: 15000, trade: "10.5K", mines: "8.5K", perk: "Better chest odds" },
  { level: 5, name: "Legend", xp: 40000, trade: "12K", mines: "10K", perk: "Max free rank" },
];

const JOURNEY = [
  { label: "Login", value: "+50 XP", icon: Flame },
  { label: "Trade", value: "+2 XP", icon: Zap },
  { label: "Mines", value: "+3 XP", icon: Target },
  { label: "Creator", value: "+50+ XP", icon: Sparkles },
  { label: "VIP Ref", value: "+10K XP", icon: Crown },
];

function rankInfo(rankXp: number) {
  const current = [...LEVELS].reverse().find((l) => rankXp >= l.xp) ?? LEVELS[0];
  const next = LEVELS.find((l) => l.xp > rankXp) ?? null;
  const progress = next ? Math.min(100, Math.round(((rankXp - current.xp) / (next.xp - current.xp)) * 100)) : 100;
  return { current, next, progress };
}

export default function ProfilePremiumLaunch() {
  const { user } = useTelegram();
  const [copied, setCopied] = useState(false);
  const vip = isVipActive(user);
  const u = user as any;
  const rankXp = u?.rankXp ?? 0;
  const creatorXp = u?.creatorXp ?? 0;
  const valueXp = u?.valueXp ?? 0;
  const { current, next, progress } = rankInfo(rankXp);
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  const { data: stats, isLoading, isError, refetch } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetUserStatsQueryKey(user?.telegramId ?? "") },
  });
  const { data: referralData } = useGetReferralStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetReferralStatsQueryKey(user?.telegramId ?? "") },
  });

  const copyReferral = async () => {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const shareTelegram = () => {
    const text = encodeURIComponent("Join me on Koinara — trade, play Mines, earn GC, and unlock VIP creator rewards.");
    const url = encodeURIComponent(referralLink);
    const shareUrl = `https://t.me/share/url?url=${url}&text=${text}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  if (isLoading) return <PageLoader rows={5} />;
  if (isError) return <PageError message="Could not load profile" onRetry={refetch} />;

  const winRate = stats ? Math.round(stats.winRate * 100) : 0;
  const loginStreak = user?.loginStreak ?? 0;

  return (
    <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
      <style>{`
        .profile-card{background:linear-gradient(160deg,rgba(13,24,44,.72),rgba(5,6,12,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}
        .brand-gold{background:linear-gradient(135deg,#fff7c7,#ffd700 45%,#ff4d8d);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      `}</style>

      <div className="mb-4 flex items-center gap-2">
        <User size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
        <span className="font-mono text-xs tracking-[0.18em] text-white/60 uppercase">Profile</span>
        <Link href="/academy"><span className="ml-auto rounded-full border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-1 font-mono text-[10px] font-black text-[#FFD700]"><BookOpen size={11} className="inline mr-1" />Academy</span></Link>
      </div>

      <section className="profile-card relative mb-4 overflow-hidden rounded-3xl p-4">
        <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-[#FFD700]/14 blur-3xl" />
        <div className="relative z-10 flex items-center gap-4">
          <div className="relative h-20 w-20 shrink-0 rounded-3xl border-2 border-[#FFD700]/45 bg-[#FFD700]/10 flex items-center justify-center shadow-[0_0_28px_rgba(255,215,0,.18)]">
            <div className="absolute inset-2 rounded-2xl border border-white/10" />
            <span className="brand-gold font-black text-3xl">{(user?.firstName ?? user?.username ?? "K").charAt(0).toUpperCase()}</span>
            {vip && <Crown size={16} className="absolute -right-1 -top-1 text-[#FFD700]" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-black text-white">{user?.firstName ?? user?.username ?? "Koin Trader"}</h1>
              <span className={`rounded-full px-2 py-1 font-mono text-[9px] font-black ${vip ? "bg-[#FFD700]/14 text-[#FFD700] border border-[#FFD700]/25" : "bg-[#00F5FF]/10 text-[#00F5FF] border border-[#00F5FF]/25"}`}>{vip ? "VIP" : "FREE"}</span>
            </div>
            {user?.username && <p className="font-mono text-xs text-white/38">@{user.username}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded-xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/8 px-2 py-1 font-mono text-[10px] font-black text-[#8BC3FF]">🔵 {(user?.tradeCredits ?? 0).toLocaleString()} TC</span>
              <span className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/8 px-2 py-1 font-mono text-[10px] font-black text-[#FFD700]">🪙 {(user?.goldCoins ?? 0).toLocaleString()} GC</span>
            </div>
          </div>
        </div>
      </section>

      <section className="profile-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Koinara Rank</div>
            <div className="mt-1 flex items-center gap-2"><Trophy size={22} className="text-[#FFD700]" /><span className="text-2xl font-black">Level {current.level} · {current.name}</span></div>
          </div>
          <div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/45">Next</div><div className="font-mono text-xs font-black text-[#FFD700]">{next ? next.name : "Max"}</div></div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/8"><motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#FF4D8D] to-[#00F5FF]" /></div>
        <div className="mt-2 flex justify-between font-mono text-[9px] text-white/35"><span>{rankXp.toLocaleString()} XP</span><span>{next ? `${(next.xp - rankXp).toLocaleString()} XP to level ${next.level}` : "Legend complete"}</span></div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-[#FFD700]/15 bg-[#FFD700]/6 p-2"><div className="font-mono text-[8px] text-white/35">TRADE CAP</div><div className="font-black text-[#FFD700]">{current.trade}</div></div>
          <div className="rounded-2xl border border-[#00F5FF]/15 bg-[#00F5FF]/6 p-2"><div className="font-mono text-[8px] text-white/35">MINES CAP</div><div className="font-black text-[#00F5FF]">{current.mines}</div></div>
          <div className="rounded-2xl border border-[#FF4D8D]/15 bg-[#FF4D8D]/6 p-2"><div className="font-mono text-[8px] text-white/35">PERK</div><div className="truncate font-mono text-[10px] font-black text-[#FF4D8D]">{current.perk}</div></div>
        </div>
      </section>

      <section className="mb-4 grid grid-cols-3 gap-2">
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] uppercase text-white/35">Creator XP</div><div className="text-xl font-black text-[#FFD700]">{creatorXp.toLocaleString()}</div></div>
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] uppercase text-white/35">Value XP</div><div className="text-xl font-black text-[#00F5FF]">{valueXp.toLocaleString()}</div></div>
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] uppercase text-white/35">Streak</div><div className="text-xl font-black text-[#FF4D8D]">{loginStreak}d</div></div>
      </section>

      <section className="profile-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Rocket size={16} className="text-[#FFD700]" /><span className="font-mono text-xs font-black uppercase tracking-[0.14em] text-[#FFD700]">Progress Engine</span></div><Link href="/earn"><span className="font-mono text-[10px] font-black text-[#00F5FF]">Earn XP →</span></Link></div>
        <div className="grid grid-cols-5 gap-2">
          {JOURNEY.map(({ label, value, icon: Icon }) => <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.025] p-2 text-center"><Icon size={15} className="mx-auto mb-1 text-[#FFD700]" /><div className="font-mono text-[8px] text-white/35">{label}</div><div className="font-mono text-[8px] font-black text-white/70">{value}</div></div>)}
        </div>
      </section>

      <section className="mb-4 grid grid-cols-2 gap-3">
        {[
          { label: "Win Rate", value: `${winRate}%`, icon: Target, color: "#00E676" },
          { label: "Trades", value: stats?.totalPredictions ?? 0, icon: Zap, color: "#4DA3FF" },
          { label: "GC Earned", value: stats?.totalGcEarned ?? 0, icon: Award, color: "#FFD700" },
          { label: "Referrals", value: referralData?.referralCount ?? stats?.referralCount ?? 0, icon: Share2, color: "#FF4D8D" },
        ].map(({ label, value, icon: Icon, color }) => <div key={label} className="profile-card rounded-2xl p-3"><div className="mb-2 flex items-center gap-2"><Icon size={13} style={{ color }} /><span className="font-mono text-[10px] uppercase tracking-wider text-white/38">{label}</span></div><div className="text-2xl font-black text-white">{String(value).toLocaleString()}</div></div>)}
      </section>

      <section className="profile-card mb-4 rounded-3xl border-[#FF4D8D]/35 bg-[#FF4D8D]/5 p-4">
        <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Crown size={17} className="text-[#FF4D8D]" /><span className="font-mono text-xs font-black uppercase tracking-[0.14em] text-[#FF4D8D]">VIP Referral Income</span></div><span className="rounded-full border border-[#FF4D8D]/25 bg-[#FF4D8D]/10 px-2 py-1 font-mono text-[9px] font-black text-[#FF4D8D]">Unlimited</span></div>
        <div className="mb-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 text-center"><div className="font-mono text-[9px] text-white/38">Direct VIP</div><div className="text-xl font-black text-[#FFD700]">20%</div></div><div className="rounded-2xl border border-[#00F5FF]/20 bg-[#00F5FF]/8 p-3 text-center"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="text-xl font-black text-[#00F5FF]">5%</div></div></div>
        <div className="mb-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[10px] text-white/35">Creator code</div><div className="font-mono text-lg font-black text-[#FFD700]">{creatorCode}</div><div className="mt-1 font-mono text-[9px] text-white/28">Use this in TikTok/Reels/YouTube captions.</div></div>
        <div className="flex gap-2"><button onClick={copyReferral} className="flex-1 rounded-2xl border border-[#FF4D8D]/35 bg-[#FF4D8D]/10 py-3 font-mono text-xs font-black text-[#FF4D8D]"><Copy size={13} className="inline mr-1" />{copied ? "Copied" : "Copy Link"}</button><button onClick={shareTelegram} className="flex-1 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/10 py-3 font-mono text-xs font-black text-[#FFD700]"><Share2 size={13} className="inline mr-1" />Share</button></div>
      </section>

      {!vip && <section className="profile-card rounded-3xl border-[#FFD700]/45 p-4 text-center"><ShieldCheck size={28} className="mx-auto mb-2 text-[#FFD700]" /><div className="font-mono text-sm font-black text-[#FFD700]">Upgrade to VIP</div><p className="my-2 font-mono text-[10px] text-white/40">Bigger caps, better conversion, creator commissions, and no first-withdrawal verification fee.</p><Link href="/wallet"><button className="rounded-2xl bg-[#FFD700] px-6 py-3 font-black text-black">Activate VIP</button></Link></section>}
    </div>
  );
}

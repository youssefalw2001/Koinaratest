import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Copy, Crown, Gift, ShieldCheck, Swords, User, Wallet, Zap } from "lucide-react";
import { useGetActiveGems, useGetReferralStats, getGetReferralStatsQueryKey, useGetUserStats, getGetUserStatsQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { PageLoader, PageError } from "@/components/PageStatus";

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  return false;
}

function powerupLabel(type: string): string {
  const labels: Record<string, string> = {
    battle_shield: "Shield",
    battle_pass: "Battle Pass",
    battle_streak_saver: "Streak Saver",
    battle_priority_queue: "Priority Queue",
  };
  return labels[type] ?? type.replace(/_/g, " ");
}

export default function ProfilePremiumLaunch() {
  const { user } = useTelegram();
  const [copied, setCopied] = useState(false);
  const vip = isVipActive(user);
  const u = user as any;
  const displayName = user?.firstName || user?.username || "Koinara Player";
  const inviteText = user ? `Join me on Koinara Battle Arena. My invite code is KNR-${String(user.telegramId).slice(-6)}.` : "Join me on Koinara Battle Arena.";

  const { data: stats, isLoading, isError, refetch } = useGetUserStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetUserStatsQueryKey(user?.telegramId ?? "") },
  });
  const { data: referralData } = useGetReferralStats(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetReferralStatsQueryKey(user?.telegramId ?? "") },
  });
  const { data: activeGems } = useGetActiveGems(user?.telegramId ?? "", { query: { enabled: !!user } });

  const battlePowerups = useMemo(() => {
    if (!Array.isArray(activeGems)) return [];
    return activeGems.filter((item) => String(item.gemType).startsWith("battle_") && (item.usesRemaining ?? 0) > 0);
  }, [activeGems]);

  const winRate = stats ? Math.round((stats.winRate ?? 0) * 100) : 0;
  const referralCount = referralData?.referralCount ?? stats?.referralCount ?? 0;
  const creatorPassPaid = Boolean(u?.creatorPassPaid);
  const crBalance = u?.creatorCredits ?? u?.creatorRewards ?? u?.creatorBalance ?? u?.referralEarnings ?? 0;
  const battleGcToday = Number(u?.dailyBattleGcEarned ?? 0);
  const battleCap = vip ? 15000 : 5000;

  const copyInvite = async () => {
    await copyText(inviteText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (isLoading) return <PageLoader rows={5} />;
  if (isError) return <PageError message="Could not load profile" onRetry={refetch} />;

  return (
    <div className="min-h-screen bg-[#05070d] px-3 pb-28 pt-3 text-white">
      <style>{`.profile-card{background:linear-gradient(160deg,rgba(13,24,44,.82),rgba(5,7,13,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 16px 48px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}.gold-title{background:linear-gradient(135deg,#fff7c7,#ffd700 48%,#b8860b);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`}</style>

      <section className="profile-card mb-3 rounded-[30px] p-4">
        <div className="flex items-center gap-4">
          <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[26px] border border-[#FFD700]/35 bg-[#FFD700]/10 shadow-[0_0_30px_rgba(255,215,0,.16)]">
            {user?.photoUrl ? <img src={user.photoUrl} alt="Profile" className="h-full w-full object-cover" /> : <User size={34} className="text-[#FFD700]" />}
            {vip && <Crown size={17} className="absolute right-2 top-2 text-[#FFD700]" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8BC3FF]">Battle Arena Profile</div>
            <h1 className="gold-title mt-1 truncate text-3xl font-black leading-none">{displayName}</h1>
            {user?.username && <div className="mt-1 font-mono text-xs text-white/42">@{user.username}</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`rounded-full border px-3 py-1 font-mono text-[10px] font-black ${vip ? "border-[#FFD700]/30 bg-[#FFD700]/10 text-[#FFD700]" : "border-white/12 bg-white/[0.035] text-white/48"}`}>{vip ? "PAID VIP ACTIVE" : "FREE USER"}</span>
              <span className="rounded-full border border-[#00F5A0]/25 bg-[#00F5A0]/8 px-3 py-1 font-mono text-[10px] font-black text-[#00F5A0]">{creatorPassPaid ? "CREATOR PASS" : "CREATOR LOCKED"}</span>
            </div>
          </div>
        </div>
        {!vip && <Link href="/vip"><button className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Crown size={16}/>Upgrade to VIP</button></Link>}
      </section>

      <section className="mb-3 grid grid-cols-3 gap-2">
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/35">TC</div><div className="font-mono text-xl font-black text-[#8BC3FF]">{(user?.tradeCredits ?? 0).toLocaleString()}</div><div className="font-mono text-[8px] text-white/25">play credits</div></div>
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/35">GC</div><div className="font-mono text-xl font-black text-[#FFD700]">{(user?.goldCoins ?? 0).toLocaleString()}</div><div className="font-mono text-[8px] text-white/25">reward coins</div></div>
        <div className="profile-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/35">CR</div><div className="font-mono text-xl font-black text-[#00F5A0]">{Number(crBalance ?? 0).toLocaleString()}</div><div className="font-mono text-[8px] text-white/25">creator credits</div></div>
      </section>

      <section className="profile-card mb-3 rounded-[28px] p-4">
        <div className="mb-3 flex items-center gap-2"><Swords size={17} className="text-[#FFD700]"/><h2 className="font-black">Battle Stats</h2><span className="ml-auto rounded-full border border-[#FFD700]/20 bg-[#FFD700]/8 px-2 py-1 font-mono text-[9px] text-[#FFD700]">BTC 60s</span></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Battles</div><div className="text-2xl font-black">{stats?.totalPredictions ?? 0}</div></div>
          <div className="rounded-2xl border border-[#00F5A0]/18 bg-[#00F5A0]/7 p-3"><div className="font-mono text-[9px] text-white/35">Win Rate</div><div className="text-2xl font-black text-[#00F5A0]">{winRate}%</div></div>
          <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/35">Wins</div><div className="text-2xl font-black text-[#FFD700]">{stats?.wins ?? 0}</div></div>
          <div className="rounded-2xl border border-[#FF4D6D]/18 bg-[#FF4D6D]/7 p-3"><div className="font-mono text-[9px] text-white/35">Losses</div><div className="text-2xl font-black text-[#FF8FA3]">{stats?.losses ?? 0}</div></div>
        </div>
        <div className="mt-3 rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3">
          <div className="flex items-center justify-between font-mono text-[10px]"><span className="text-white/45">Battle GC today</span><span className="text-[#FFD700]">{battleGcToday.toLocaleString()} / {battleCap.toLocaleString()}</span></div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] to-[#FF4D6D]" style={{ width: `${Math.min(100, (battleGcToday / battleCap) * 100)}%` }} /></div>
        </div>
      </section>

      <section className="profile-card mb-3 rounded-[28px] p-4">
        <div className="mb-3 flex items-center gap-2"><ShieldCheck size={17} className="text-[#8BC3FF]"/><h2 className="font-black">Battle Power-ups</h2><Link href="/shop" className="ml-auto font-mono text-[10px] font-black text-[#FFD700]">Shop →</Link></div>
        {battlePowerups.length === 0 ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">No active Battle power-ups. Buy Shield, Battle Pass, Streak Saver, or Priority Queue in Shop.</div> : <div className="grid grid-cols-2 gap-2">{battlePowerups.map((item) => <div key={`${item.id}-${item.gemType}`} className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-black text-[#FFD700]">{powerupLabel(String(item.gemType))}</div><div className="font-mono text-[9px] text-white/38">{item.usesRemaining ?? 0} active</div></div>)}</div>}
      </section>

      <section className="profile-card mb-3 rounded-[28px] p-4">
        <div className="mb-3 flex items-center gap-2"><Gift size={17} className="text-[#00F5A0]"/><h2 className="font-black">Creator & Referrals</h2></div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Code</div><div className="font-mono text-xs font-black text-[#FFD700]">{user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR"}</div></div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Referrals</div><div className="text-xl font-black text-[#00F5A0]">{referralCount}</div></div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Status</div><div className="font-mono text-[10px] font-black text-[#8BC3FF]">{creatorPassPaid ? "Active" : "Locked"}</div></div>
        </div>
        <button onClick={copyInvite} className="mt-3 w-full rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/10 py-3 font-mono text-xs font-black text-[#FFD700]"><Copy size={13} className="mr-1 inline"/>{copied ? "Copied" : "Copy Invite Text"}</button>
      </section>

      <section className="profile-card mb-3 rounded-[28px] p-4">
        <div className="mb-3 flex items-center gap-2"><Wallet size={17} className="text-[#FFD700]"/><h2 className="font-black">Wallet Safety</h2></div>
        <div className="space-y-2 font-mono text-[10px] leading-relaxed text-white/50">
          <div className="rounded-2xl border border-[#8BC3FF]/20 bg-[#8BC3FF]/7 p-3">TC is play credit for Battles and Mines. TC is not withdrawable.</div>
          <div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-3">GC and CR withdrawals follow eligibility, caps, fees, and anti-abuse checks.</div>
          <div className="rounded-2xl border border-[#00F5A0]/20 bg-[#00F5A0]/7 p-3">Paid VIP can improve limits where wallet rules allow it. VIP does not guarantee winnings.</div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <Link href="/battle"><button className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Zap size={15} className="mr-1 inline"/>Battle</button></Link>
        <Link href="/wallet"><button className="w-full rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 py-3 font-black text-[#FFD700]"><Wallet size={15} className="mr-1 inline"/>Wallet</button></Link>
      </section>
    </div>
  );
}

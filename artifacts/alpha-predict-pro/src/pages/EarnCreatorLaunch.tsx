import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle, Copy, Gift, Play, Share2, Sparkles, Tv, Video } from "lucide-react";
import { Link } from "wouter";
import { getGetAdStatusQueryKey, getGetUserQueryKey, useClaimDailyReward, useGetAdStatus, useWatchAd } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

type EarnTab = "daily" | "invite" | "create";
const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const CREATOR_PASS_USD = 0.99;
const CREATOR_PASS_INR = 82;

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.focus();
    input.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(input);
    return ok;
  } catch {
    return false;
  }
}

function moneyFromGc(gc: number, rate: number) {
  return `$${(gc / rate).toFixed(2)}`;
}

export default function EarnCreatorLaunch() {
  const { user, refreshUser } = useTelegram();
  const u = user as any;
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [activeTab, setActiveTab] = useState<EarnTab>("daily");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showAdToast, setShowAdToast] = useState<{ tc: number; left: number } | null>(null);

  const claimDaily = useClaimDailyReward();
  const watchAdMutation = useWatchAd();
  const { data: adStatusData, refetch: refetchAdStatus } = useGetAdStatus(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: getGetAdStatusQueryKey(user?.telegramId ?? "") } });

  const creatorPassActive = vip || !!u?.creatorPassPaid;
  const creatorPassMissingBackend = !vip && typeof u?.creatorPassPaid === "undefined";
  const gcPerUsd = vip ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const adDailyCap = adStatusData?.dailyCap ?? (vip ? 25 : 5);
  const adsWatchedToday = adStatusData?.adsWatchedToday ?? 0;
  const adsRemaining = Math.max(0, adDailyCap - adsWatchedToday);
  const adTcReward = vip ? 100 : 80;
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const referralLevel1 = u?.directReferralCount ?? u?.referralCount ?? 0;
  const referralLevel2 = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const referralGc = u?.referralEarnings ?? u?.referralEarningsGc ?? 0;
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  const quests = useMemo(() => [
    { title: "Claim daily bonus", detail: "Return daily to build your streak", done: false },
    { title: "Watch ads", detail: `${adsWatchedToday}/${adDailyCap} watched today`, done: adsRemaining <= 0 },
    { title: "Invite a real user", detail: `${referralLevel1} direct referrals`, done: referralLevel1 > 0 },
    { title: "Open Creator Pass", detail: creatorPassActive ? "Creator access active" : "$0.99 creator business tab", done: creatorPassActive },
  ], [adsWatchedToday, adDailyCap, adsRemaining, referralLevel1, creatorPassActive]);

  const showFeedback = (ok: boolean, msg: string, ms = 3000) => {
    setFeedback({ ok, msg });
    window.setTimeout(() => setFeedback(null), ms);
  };

  const handleClaimDaily = async () => {
    if (!user || claimDaily.isPending) return;
    try {
      const result = await claimDaily.mutateAsync({ data: { telegramId: user.telegramId } });
      showFeedback(true, `Daily bonus claimed: +${result.tcAwarded} TC · Day ${result.streak} streak`, 3500);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      refreshUser?.();
    } catch {
      showFeedback(false, "Daily bonus is not available yet. Try again later.");
    }
  };

  const handleCopyInvite = async () => {
    if (!referralLink) return;
    const ok = await copyText(referralLink);
    if (ok) showFeedback(true, "Invite link copied.");
    else handleShareTelegram();
  };

  const handleShareTelegram = () => {
    if (!referralLink) return;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join me on Koinara. Creator Pass users can earn from verified referral purchases and approved content.")}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  const handleWatchAd = async () => {
    if (!user || adsRemaining <= 0 || watchAdMutation.isPending) return;
    try {
      const result = await watchAdMutation.mutateAsync({ data: { telegramId: user.telegramId } });
      setShowAdToast({ tc: result.tcAwarded, left: result.dailyCap - result.adsWatchedToday });
      window.setTimeout(() => setShowAdToast(null), 3000);
      refetchAdStatus();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {
      showFeedback(false, "Ad reward failed. Try again.");
    }
  };

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.earn-card{background:linear-gradient(160deg,rgba(13,24,44,.72),rgba(6,8,16,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}`}</style>
    <AnimatePresence>{showAdToast && <motion.div initial={{ opacity:0,y:-18 }} animate={{ opacity:1,y:0 }} exit={{ opacity:0,y:-18 }} className="fixed top-4 left-1/2 z-[90] -translate-x-1/2 rounded-2xl border border-[#00F5FF]/35 bg-black/90 px-5 py-3 shadow-[0_0_30px_rgba(0,245,255,.25)]"><div className="flex items-center gap-2 font-mono text-xs font-black text-[#00F5FF]"><CheckCircle size={15}/>+{showAdToast.tc} TC · {showAdToast.left} ads left</div></motion.div>}</AnimatePresence>

    <div className="mb-4 flex items-center gap-2"><Gift size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Earn</span><Link href="/creator"><span className="ml-auto rounded-full border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-1 font-mono text-[10px] font-black text-[#FFD700]">Creator Pass</span></Link></div>
    {feedback && <div className={`mb-4 rounded-2xl border px-3 py-2 font-mono text-[10px] ${feedback.ok ? "border-[#00F5FF]/30 bg-[#00F5FF]/8 text-[#00F5FF]" : "border-[#FF4D8D]/30 bg-[#FF4D8D]/8 text-[#FF4D8D]"}`}>{feedback.ok ? <CheckCircle size={12} className="inline mr-1"/> : <AlertCircle size={12} className="inline mr-1"/>}{feedback.msg}</div>}

    <section className={`earn-card mb-4 rounded-3xl p-4 ${creatorPassActive ? "border-[#00F5A0]/35" : "border-[#FFD700]/35"}`}>
      {!creatorPassActive ? <>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Creator Pass</div>
        <h2 className="text-2xl font-black">Turn $0.99 into creator earnings</h2>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/52">Buy Creator Pass and earn 20% commission every time someone you invite makes a verified purchase.</p>
        <div className="mt-3 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-white/60">Refer 5 VIP users = estimated $5.99/month while active.</div>
        <Link href="/creator"><button className="mt-3 w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black">Get Creator Pass — ${CREATOR_PASS_USD.toFixed(2)} / ₹{CREATOR_PASS_INR}</button></Link>
        {creatorPassMissingBackend && <p className="mt-2 font-mono text-[9px] text-[#FFD700]/65">TODO backend: creatorPassPaid is not available yet, so Earn treats Creator Pass as locked unless VIP.</p>}
      </> : <>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Your Creator Business</div>
        <h2 className="text-2xl font-black">Creator Pass Active ✓</h2>
        <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Commissions</div><div className="text-xl font-black text-[#FFD700]">{referralGc.toLocaleString()} GC</div><div className="font-mono text-[9px] text-white/35">{moneyFromGc(referralGc, gcPerUsd)}</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Active refs</div><div className="text-xl font-black text-[#00F5FF]">{referralLevel1}</div><div className="font-mono text-[9px] text-white/35">Level 1</div></div></div>
        <Link href="/creator"><button className="mt-3 w-full rounded-2xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 py-3 font-black text-[#00F5A0]">Open Creator Dashboard</button></Link>
      </>}
    </section>

    <div className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
      {([["daily", "Daily", Gift], ["invite", "Invite", Share2], ["create", "Create", Video]] as const).map(([id, label, Icon]) => <button key={id} onClick={() => setActiveTab(id)} className={`rounded-xl py-2.5 font-mono text-xs font-black ${activeTab === id ? "border border-[#FFD700]/25 bg-[#FFD700]/14 text-[#FFD700]" : "text-white/35"}`}><Icon size={12} className="inline mr-1"/>{label}</button>)}
    </div>

    {activeTab === "daily" && <div className="space-y-4">
      <section className="earn-card rounded-3xl p-4"><div className="mb-3 flex items-center justify-between gap-3"><div><div className="font-black text-xl">Daily login bonus</div><div className="font-mono text-[10px] text-white/45">Claim your daily TC and keep your streak alive.</div></div><Sparkles className="text-[#FFD700]"/></div><button onClick={handleClaimDaily} disabled={!user || claimDaily.isPending} className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black disabled:opacity-45">{claimDaily.isPending ? "Claiming..." : "Claim Daily Bonus"}</button></section>
      <section className="earn-card rounded-3xl border-[#FF4D8D]/30 p-4"><div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-3"><Tv size={22} className="text-[#FF4D8D]"/><div><div className="font-black text-lg">Watch ads</div><div className="font-mono text-[10px] text-white/45">{adsWatchedToday} of {adDailyCap} watched today</div></div></div><div className="font-mono text-lg font-black text-[#FF4D8D]">+{adTcReward} TC</div></div><div className="mb-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-[#FF4D8D]" style={{ width: `${Math.min(100, (adsWatchedToday / adDailyCap) * 100)}%` }}/></div><button onClick={handleWatchAd} disabled={adsRemaining <= 0 || watchAdMutation.isPending} className="w-full rounded-2xl border border-[#FF4D8D]/35 bg-[#FF4D8D]/10 py-3 font-mono text-sm font-black text-[#FF4D8D] disabled:opacity-40"><Play size={14} className="inline mr-2"/>{adsRemaining > 0 ? `Watch Ad · ${adsRemaining} left` : "Daily ad cap reached"}</button></section>
      <section className="earn-card rounded-3xl p-4"><div className="mb-3 font-black text-lg">Quest list</div><div className="space-y-2">{quests.map((quest) => <div key={quest.title} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${quest.done ? "border-[#00F5A0]/30 bg-[#00F5A0]/10 text-[#00F5A0]" : "border-[#FFD700]/25 bg-[#FFD700]/10 text-[#FFD700]"}`}>{quest.done ? <CheckCircle size={15}/> : <Gift size={14}/>}</div><div className="flex-1"><div className="font-black text-sm">{quest.title}</div><div className="font-mono text-[10px] text-white/40">{quest.detail}</div></div></div>)}</div></section>
      <Link href="/lootbox"><section className="earn-card flex items-center justify-between rounded-3xl p-4"><div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Bonus Feature</div><div className="font-black text-lg">Open Lootbox</div></div><Sparkles className="text-[#FFD700]"/></section></Link>
    </div>}

    {activeTab === "invite" && <section className="earn-card rounded-3xl border-[#FFD700]/35 p-4"><div className="mb-3 flex items-center gap-3"><Share2 size={22} className="text-[#FFD700]"/><div><div className="font-black text-xl">Invite & earn</div><div className="font-mono text-[10px] text-white/45">Creator Pass commissions from real buyers.</div></div></div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] text-white/44 break-all">{referralLink || "Open inside Telegram to generate your invite link."}</div><div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-white/60"><div>Share your link.</div><div>When someone you invite buys Creator Pass or VIP, you earn 20% commission paid in GC.</div><div>Only real successful payments count.</div></div><div className="mb-3 grid grid-cols-3 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 1</div><div className="text-2xl font-black text-[#FFD700]">{referralLevel1}</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="text-2xl font-black text-[#00F5FF]">{referralLevel2}</div></div><div className="rounded-2xl border border-[#FF4D8D]/18 bg-[#FF4D8D]/8 p-3"><div className="font-mono text-[9px] text-white/38">Earned</div><div className="text-2xl font-black text-[#FF4D8D]">{referralGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/30">GC</div></div></div><div className="grid grid-cols-2 gap-2"><button onClick={handleCopyInvite} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Copy size={14} className="inline mr-2"/>Copy Link</button><button onClick={handleShareTelegram} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="inline mr-2"/>Share on Telegram</button></div></section>}

    {activeTab === "create" && <div className="space-y-4">{!creatorPassActive ? <section className="earn-card rounded-3xl border-[#00F5A0]/35 p-4"><div className="mb-3 flex items-center gap-3"><Video size={24} className="text-[#00F5A0]"/><div><div className="font-black text-xl">Creator Pass required</div><div className="font-mono text-[10px] text-white/45">Content submissions unlock with Creator Pass or VIP.</div></div></div><p className="mb-4 font-mono text-[10px] leading-relaxed text-white/48">Creator Pass is the $0.99/month creator business product. It is separate from Withdrawal Verification and VIP.</p><Link href="/creator"><button className="w-full rounded-2xl bg-[#00F5A0] py-3 font-black text-black">Open Creator Pass</button></Link></section> : <section className="earn-card rounded-3xl p-4"><div className="mb-3 flex items-center gap-3"><Video size={24} className="text-[#FFD700]"/><div><div className="font-black text-xl">Submit content in Creator tab</div><div className="font-mono text-[10px] text-white/45">Use your Creator Dashboard for submissions and history.</div></div></div><div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]">Creator code: <b>{creatorCode}</b></div><Link href="/creator"><button className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black">Open Creator Dashboard</button></Link></section>}</div>}
  </div>;
}

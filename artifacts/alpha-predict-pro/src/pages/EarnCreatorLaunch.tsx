import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, CheckCircle, Copy, Gift, Play, Send, Share2, ShieldAlert, Sparkles, Tv, Video } from "lucide-react";
import { Link } from "wouter";
import { getGetAdStatusQueryKey, getGetUserQueryKey, useClaimDailyReward, useGetAdStatus, useWatchAd } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

type EarnTab = "daily" | "invite" | "create";
type CreatorSubmission = { id: number; platform: string; postType?: string; url: string; status: string; xpAwarded?: number; tcAwarded?: number; gcAwarded?: number; viewCount?: number; vipReferrals?: number; createdAt?: string };
type ContentPlatform = "tiktok" | "instagram" | "youtube" | "x" | "whatsapp";
type PostType = "story" | "post" | "short" | "long";

const CREATOR_UNLOCK_USD = 0.99;
const CREATOR_UNLOCK_INR = 82;

const PLATFORMS: Array<{ id: ContentPlatform; label: string }> = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "instagram", label: "Reels" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
];

const POST_TYPES: Array<{ id: PostType; label: string; hint: string }> = [
  { id: "story", label: "Story", hint: "Daily streak" },
  { id: "short", label: "Short", hint: "Fast reach" },
  { id: "long", label: "Long", hint: "$25 review" },
  { id: "post", label: "Post", hint: "Standard" },
];

const REWARD_TIERS = [
  { label: "WhatsApp Story", reward: "daily XP + TC streak", note: "best local trust" },
  { label: "Reels / Shorts", reward: "XP + TC + referral boost", note: "views help, referrals matter" },
  { label: "YouTube video", reward: "bigger XP + TC", note: "best serious proof" },
  { label: "100K+ YouTube", reward: "$25 USDT review", note: "owner verifies real views" },
  { label: "VIP referral", reward: "20% direct commission", note: "highest value action" },
];

function apiBase() {
  return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
}

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

export default function EarnCreatorLaunch() {
  const { user, refreshUser } = useTelegram();
  const u = user as any;
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [activeTab, setActiveTab] = useState<EarnTab>("daily");
  const [contentUrl, setContentUrl] = useState("");
  const [caption, setCaption] = useState("Koinara creator mission");
  const [platform, setPlatform] = useState<ContentPlatform>("whatsapp");
  const [postType, setPostType] = useState<PostType>("story");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<CreatorSubmission[]>([]);
  const [showAdToast, setShowAdToast] = useState<{ tc: number; left: number } | null>(null);

  const claimDaily = useClaimDailyReward();
  const watchAdMutation = useWatchAd();
  const { data: adStatusData, refetch: refetchAdStatus } = useGetAdStatus(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: getGetAdStatusQueryKey(user?.telegramId ?? "") } });

  const adDailyCap = adStatusData?.dailyCap ?? (vip ? 25 : 5);
  const adsWatchedToday = adStatusData?.adsWatchedToday ?? 0;
  const adsRemaining = Math.max(0, adDailyCap - adsWatchedToday);
  const adTcReward = vip ? 100 : 80;
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const referralLevel1 = u?.referralCount ?? u?.directReferralCount ?? 0;
  const referralLevel2 = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const referralGc = u?.referralEarnings ?? u?.referralEarningsGc ?? 0;
  const creatorUnlocked = vip || !!u?.creatorUnlockPaid || !!u?.contentRewardsUnlocked || u?.creatorStatus === "unlocked";

  const fetchSubmissions = async () => {
    if (!user) return;
    try {
      const initData = window.Telegram?.WebApp?.initData ?? "";
      const res = await fetch(`${apiBase()}/api/content/${user.telegramId}`, { headers: initData ? { "x-telegram-init-data": initData } : {} });
      if (!res.ok) return;
      const data = await res.json();
      setSubmissions(Array.isArray(data?.submissions) ? data.submissions : []);
    } catch {}
  };

  useEffect(() => { fetchSubmissions(); }, [user?.telegramId]);

  const creatorStats = useMemo(() => ({
    approved: submissions.filter((s) => s.status === "approved" || s.status === "rewarded").length,
    pending: submissions.filter((s) => s.status === "pending").length,
    rejected: submissions.filter((s) => s.status === "rejected").length,
  }), [submissions]);

  const quests = useMemo(() => [
    { title: "Claim daily bonus", detail: "Return daily to build your streak", done: false },
    { title: "Watch ads", detail: `${adsWatchedToday}/${adDailyCap} watched today`, done: adsRemaining <= 0 },
    { title: "Invite a real user", detail: `${referralLevel1} direct referrals`, done: referralLevel1 > 0 },
    { title: "Submit creator content", detail: `${creatorStats.pending + creatorStats.approved} submissions`, done: creatorStats.approved > 0 },
  ], [adsWatchedToday, adDailyCap, adsRemaining, referralLevel1, creatorStats.pending, creatorStats.approved]);

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
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join me on Koinara. If you buy VIP or Creator Unlock, I earn creator commission.")}`;
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

  const handleSubmitContent = async () => {
    if (!user || !contentUrl.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const initData = window.Telegram?.WebApp?.initData ?? "";
      const res = await fetch(`${apiBase()}/api/content/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(initData ? { "x-telegram-init-data": initData } : {}) },
        body: JSON.stringify({ telegramId: user.telegramId, platform, postType, url: contentUrl.trim(), caption: `${caption} ${creatorCode}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Submission failed");
      setContentUrl("");
      showFeedback(true, data?.message ?? "Content submitted. Review pending.", 4500);
      fetchSubmissions();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      showFeedback(false, err instanceof Error ? err.message : "Invalid URL or submission failed.", 4500);
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.earn-card{background:linear-gradient(160deg,rgba(13,24,44,.72),rgba(6,8,16,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}`}</style>
    <AnimatePresence>{showAdToast && <motion.div initial={{ opacity:0,y:-18 }} animate={{ opacity:1,y:0 }} exit={{ opacity:0,y:-18 }} className="fixed top-4 left-1/2 z-[90] -translate-x-1/2 rounded-2xl border border-[#00F5FF]/35 bg-black/90 px-5 py-3 shadow-[0_0_30px_rgba(0,245,255,.25)]"><div className="flex items-center gap-2 font-mono text-xs font-black text-[#00F5FF]"><CheckCircle size={15}/>+{showAdToast.tc} TC · {showAdToast.left} ads left</div></motion.div>}</AnimatePresence>

    <div className="mb-4 flex items-center gap-2"><Gift size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]"/><span className="font-mono text-xs tracking-[0.18em] text-white/60 uppercase">Earn</span><Link href="/creator"><span className="ml-auto rounded-full border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-1 font-mono text-[10px] font-black text-[#FFD700]">Creator Center</span></Link></div>

    {feedback && <div className={`mb-4 rounded-2xl border px-3 py-2 font-mono text-[10px] ${feedback.ok ? "border-[#00F5FF]/30 bg-[#00F5FF]/8 text-[#00F5FF]" : "border-[#FF4D8D]/30 bg-[#FF4D8D]/8 text-[#FF4D8D]"}`}>{feedback.ok ? <CheckCircle size={12} className="inline mr-1"/> : <AlertCircle size={12} className="inline mr-1"/>}{feedback.msg}</div>}

    <div className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
      {([
        ["daily", "Daily", Gift],
        ["invite", "Invite", Share2],
        ["create", "Create", Video],
      ] as const).map(([id, label, Icon]) => <button key={id} onClick={() => setActiveTab(id)} className={`rounded-xl py-2.5 font-mono text-xs font-black ${activeTab === id ? "border border-[#FFD700]/25 bg-[#FFD700]/14 text-[#FFD700]" : "text-white/35"}`}><Icon size={12} className="inline mr-1"/>{label}</button>)}
    </div>

    {activeTab === "daily" && <div className="space-y-4">
      <section className="earn-card rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between gap-3"><div><div className="font-black text-xl">Daily login bonus</div><div className="font-mono text-[10px] text-white/45">Claim your daily TC and keep your streak alive.</div></div><Sparkles className="text-[#FFD700]"/></div>
        <button onClick={handleClaimDaily} disabled={!user || claimDaily.isPending} className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black disabled:opacity-45">{claimDaily.isPending ? "Claiming..." : "Claim Daily Bonus"}</button>
      </section>

      <section className="earn-card rounded-3xl p-4 border-[#FF4D8D]/30">
        <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-3"><Tv size={22} className="text-[#FF4D8D]"/><div><div className="font-black text-lg">Watch ads</div><div className="font-mono text-[10px] text-white/45">{adsWatchedToday} of {adDailyCap} watched today</div></div></div><div className="font-mono text-lg font-black text-[#FF4D8D]">+{adTcReward} TC</div></div>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-[#FF4D8D]" style={{ width: `${Math.min(100, (adsWatchedToday / adDailyCap) * 100)}%` }} /></div>
        <button onClick={handleWatchAd} disabled={adsRemaining <= 0 || watchAdMutation.isPending} className="w-full rounded-2xl border border-[#FF4D8D]/35 bg-[#FF4D8D]/10 py-3 font-mono text-sm font-black text-[#FF4D8D] disabled:opacity-40"><Play size={14} className="inline mr-2"/>{adsRemaining > 0 ? `Watch Ad · ${adsRemaining} left` : "Daily ad cap reached"}</button>
      </section>

      <section className="earn-card rounded-3xl p-4">
        <div className="mb-3 font-black text-lg">Quest list</div>
        <div className="space-y-2">
          {quests.map((quest) => <div key={quest.title} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${quest.done ? "border-[#00F5A0]/30 bg-[#00F5A0]/10 text-[#00F5A0]" : "border-[#FFD700]/25 bg-[#FFD700]/10 text-[#FFD700]"}`}>{quest.done ? <CheckCircle size={15}/> : <Gift size={14}/>}</div><div className="flex-1"><div className="font-black text-sm">{quest.title}</div><div className="font-mono text-[10px] text-white/40">{quest.detail}</div></div></div>)}
        </div>
      </section>

      <Link href="/lootbox"><section className="earn-card rounded-3xl p-4 flex items-center justify-between"><div><div className="font-mono text-[10px] text-[#FFD700] tracking-[0.18em] uppercase">Bonus Feature</div><div className="font-black text-lg">Open Lootbox</div></div><Sparkles className="text-[#FFD700]"/></section></Link>
    </div>}

    {activeTab === "invite" && <div className="space-y-4">
      <section className="earn-card rounded-3xl p-4 border-[#FFD700]/35">
        <div className="mb-3 flex items-center gap-3"><Share2 size={22} className="text-[#FFD700]"/><div><div className="font-black text-xl">Invite & earn</div><div className="font-mono text-[10px] text-white/45">Creator commissions from real buyers.</div></div></div>
        <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] text-white/44 break-all">{referralLink || "Open inside Telegram to generate your invite link."}</div>
        <div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-white/60">
          <div>Share your link.</div>
          <div>When someone you invite buys VIP or Creator Unlock, you earn 20% commission directly to your wallet.</div>
          <div>Only real successful payments count.</div>
        </div>
        <div className="mb-3 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 1</div><div className="text-2xl font-black text-[#FFD700]">{referralLevel1}</div></div>
          <div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="text-2xl font-black text-[#00F5FF]">{referralLevel2}</div></div>
          <div className="rounded-2xl border border-[#FF4D8D]/18 bg-[#FF4D8D]/8 p-3"><div className="font-mono text-[9px] text-white/38">Earned</div><div className="text-2xl font-black text-[#FF4D8D]">{referralGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/30">GC</div></div>
        </div>
        <div className="grid grid-cols-2 gap-2"><button onClick={handleCopyInvite} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Copy size={14} className="inline mr-2"/>Copy Link</button><button onClick={handleShareTelegram} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="inline mr-2"/>Share on Telegram</button></div>
      </section>
    </div>}

    {activeTab === "create" && <div className="space-y-4">
      {!creatorUnlocked ? <section className="earn-card rounded-3xl p-4 border-[#00F5A0]/35">
        <div className="mb-3 flex items-center gap-3"><Video size={24} className="text-[#00F5A0]"/><div><div className="font-black text-xl">Unlock Content Rewards — ${CREATOR_UNLOCK_USD.toFixed(2)} / ₹{CREATOR_UNLOCK_INR}</div><div className="font-mono text-[10px] text-white/45">Post videos about Koinara and earn GC from verified views.</div></div></div>
        <p className="mb-4 font-mono text-[10px] leading-relaxed text-white/48">Unlock creator review tools, submit proof, and earn from approved content and real user activity. Rewards are reviewed and not guaranteed.</p>
        <Link href="/wallet"><button className="w-full rounded-2xl bg-[#00F5A0] py-3 font-black text-black">Unlock for $0.99</button></Link>
      </section> : <>
        <section className="earn-card rounded-3xl p-4 border-[#FFD700]/35">
          <div className="mb-3 flex items-center gap-3"><Video size={24} className="text-[#FFD700]"/><div><div className="font-black text-xl">Submit content</div><div className="font-mono text-[10px] text-white/45">WhatsApp, Reels, YouTube, TikTok.</div></div></div>
          <div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]">Add this code to your caption, bio, pinned comment, or video: <b>{creatorCode}</b></div>
          <div className="mb-3 grid grid-cols-4 gap-1.5">{PLATFORMS.map((p) => <button key={p.id} onClick={() => { setPlatform(p.id); if (p.id === "whatsapp") setPostType("story"); if (p.id === "youtube") setPostType("long"); }} className={`rounded-xl border py-2 font-mono text-[10px] font-black ${platform === p.id ? "border-[#00F5FF] bg-[#00F5FF]/12 text-[#00F5FF]" : "border-white/10 text-white/35"}`}>{p.label}</button>)}</div>
          <div className="mb-3 grid grid-cols-4 gap-1.5">{POST_TYPES.map((p) => <button key={p.id} onClick={() => setPostType(p.id)} className={`rounded-xl border py-2 ${postType === p.id ? "border-[#FFD700] bg-[#FFD700]/12 text-[#FFD700]" : "border-white/10 text-white/35"}`}><div className="font-mono text-[10px] font-black">{p.label}</div><div className="font-mono text-[8px] opacity-60">{p.hint}</div></button>)}</div>
          <input value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} placeholder="Paste WhatsApp proof / Reel / YouTube link" className="mb-2 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-xs text-white outline-none focus:border-[#00F5FF]/50"/>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption / proof text" className="mb-3 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-xs text-white outline-none focus:border-[#FFD700]/50"/>
          <button onClick={handleSubmitContent} disabled={!contentUrl.trim() || submitting} className="w-full rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FF4D8D] py-3 font-black text-black disabled:opacity-45"><Send size={14} className="inline mr-2"/>{submitting ? "Submitting..." : "Submit for Review"}</button>
          <p className="mt-2 text-center font-mono text-[9px] text-white/28">Views alone do not guarantee rewards. Real signups and VIP referrals matter most.</p>
        </section>

        <section className="earn-card rounded-3xl p-4">
          <div className="mb-3 font-black text-lg">Submission history</div>
          {submissions.length > 0 ? <div className="space-y-2">{submissions.slice(0, 8).map((sub) => <div key={sub.id} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><Video size={18} className="text-[#FFD700]"/><div className="min-w-0 flex-1"><div className="truncate font-mono text-[10px] text-white/60">{sub.url}</div><div className="font-mono text-[9px] capitalize text-white/30">{sub.platform} · {sub.postType ?? "post"}</div></div><div className={`rounded-full px-2 py-1 font-mono text-[9px] font-black ${sub.status === "approved" ? "bg-[#00F5FF]/10 text-[#00F5FF]" : sub.status === "rejected" ? "bg-[#FF4D8D]/10 text-[#FF4D8D]" : "bg-[#FFD700]/10 text-[#FFD700]"}`}>{sub.status}</div></div>)}</div> : <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">No submissions yet.</div>}
          <div className="mt-3 grid grid-cols-3 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Pending</div><div className="text-xl font-black text-[#FFD700]">{creatorStats.pending}</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Approved</div><div className="text-xl font-black text-[#00F5FF]">{creatorStats.approved}</div></div><div className="rounded-2xl border border-[#FF4D8D]/18 bg-[#FF4D8D]/8 p-3"><div className="font-mono text-[9px] text-white/38">Rejected</div><div className="text-xl font-black text-[#FF4D8D]">{creatorStats.rejected}</div></div></div>
        </section>
      </>}

      <section className="earn-card rounded-3xl p-4">
        <div className="mb-3 font-black text-lg">Reward tiers</div>
        <div className="space-y-2">{REWARD_TIERS.map((tier, index) => <div key={tier.label} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/10 font-black text-[#FFD700]">{index + 1}</div><div className="flex-1"><div className="font-black text-sm">{tier.label}</div><div className="font-mono text-[10px] text-white/40">{tier.note}</div></div><div className="text-right font-mono text-[10px] font-black text-[#FFD700]">{tier.reward}</div></div>)}</div>
        <div className="mt-3 rounded-2xl border border-[#FF4D8D]/25 bg-[#FF4D8D]/8 p-3 font-mono text-[10px] leading-relaxed text-white/48"><ShieldAlert size={13} className="inline mr-1 text-[#FF4D8D]"/>Fake views, duplicate content, stolen videos, self-referrals, bot traffic, or fake proof can be rejected.</div>
      </section>
    </div>}
  </div>;
}

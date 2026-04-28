import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, CheckCircle, Crown, Gift, MessageCircle, Play, Rocket, Send, Share2, ShieldAlert, Sparkles, Trophy, Tv, Video } from "lucide-react";
import { Link } from "wouter";
import { getGetAdStatusQueryKey, getGetUserQueryKey, useGetAdStatus, useWatchAd } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

type CreatorSubmission = { id: number; platform: string; postType?: string; url: string; status: string; xpAwarded?: number; tcAwarded?: number; gcAwarded?: number; viewCount?: number; vipReferrals?: number; createdAt?: string };
type ContentPlatform = "tiktok" | "instagram" | "youtube" | "x" | "whatsapp";
type PostType = "story" | "post" | "short" | "long";

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
const LEVELS = [
  { level: 1, name: "Rookie", xp: 0, trade: "7K", mines: "5K" },
  { level: 2, name: "Trader", xp: 1500, trade: "8K", mines: "6K" },
  { level: 3, name: "Pro", xp: 5000, trade: "9K", mines: "7K" },
  { level: 4, name: "Elite", xp: 15000, trade: "10.5K", mines: "8.5K" },
  { level: 5, name: "Legend", xp: 40000, trade: "12K", mines: "10K" },
];
const REWARD_TIERS = [
  { label: "WhatsApp Story", reward: "daily XP + TC streak", note: "best local trust" },
  { label: "Reels / Shorts", reward: "XP + TC + referral boost", note: "views help, referrals matter" },
  { label: "YouTube video", reward: "bigger XP + TC", note: "best serious proof" },
  { label: "100K+ YouTube", reward: "$25 USDT review", note: "owner verifies real views" },
  { label: "VIP referral", reward: "unlimited upside", note: "highest XP + commission" },
];

function apiBase() { return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""; }
function rankInfo(rankXp: number) {
  const current = [...LEVELS].reverse().find((l) => rankXp >= l.xp) ?? LEVELS[0];
  const next = LEVELS.find((l) => l.xp > rankXp) ?? null;
  const progress = next ? Math.min(100, Math.round(((rankXp - current.xp) / (next.xp - current.xp)) * 100)) : 100;
  return { current, next, progress };
}

export default function EarnCreatorLaunch() {
  const { user } = useTelegram();
  const u = user as any;
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const rankXp = u?.rankXp ?? 0;
  const creatorXp = u?.creatorXp ?? 0;
  const { current, next, progress } = rankInfo(rankXp);
  const [activeTab, setActiveTab] = useState<"earn" | "creator">("earn");
  const [contentUrl, setContentUrl] = useState("");
  const [caption, setCaption] = useState("Koinara creator mission");
  const [platform, setPlatform] = useState<ContentPlatform>("whatsapp");
  const [postType, setPostType] = useState<PostType>("story");
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<CreatorSubmission[]>([]);
  const [showAdToast, setShowAdToast] = useState<{ tc: number; left: number } | null>(null);
  const watchAdMutation = useWatchAd();
  const { data: adStatusData, refetch: refetchAdStatus } = useGetAdStatus(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: getGetAdStatusQueryKey(user?.telegramId ?? "") } });
  const adDailyCap = adStatusData?.dailyCap ?? (vip ? 25 : 5);
  const adsWatchedToday = adStatusData?.adsWatchedToday ?? 0;
  const adsRemaining = Math.max(0, adDailyCap - adsWatchedToday);
  const adTcReward = vip ? 100 : 80;
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";

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

  const handleWatchAd = async () => {
    if (!user || adsRemaining <= 0 || watchAdMutation.isPending) return;
    try {
      const result = await watchAdMutation.mutateAsync({ data: { telegramId: user.telegramId } });
      setShowAdToast({ tc: result.tcAwarded, left: result.dailyCap - result.adsWatchedToday });
      setTimeout(() => setShowAdToast(null), 3000);
      refetchAdStatus();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch { setFeedback({ ok: false, msg: "Ad reward failed. Try again." }); setTimeout(() => setFeedback(null), 2500); }
  };

  const handleSubmitContent = async () => {
    if (!user || !contentUrl.trim()) return;
    setSubmitting(true); setFeedback(null);
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
      setFeedback({ ok: true, msg: data?.message ?? "+50 XP submitted. Review pending." });
      fetchSubmissions();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) { setFeedback({ ok: false, msg: err instanceof Error ? err.message : "Invalid URL or submission failed." }); }
    finally { setSubmitting(false); setTimeout(() => setFeedback(null), 4500); }
  };

  const creatorStats = useMemo(() => ({ approved: submissions.filter((s) => s.status === "approved" || s.status === "rewarded").length, pending: submissions.filter((s) => s.status === "pending").length, vipRefs: submissions.reduce((sum, s) => sum + (s.vipReferrals ?? 0), 0) }), [submissions]);

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.earn-card{background:linear-gradient(160deg,rgba(13,24,44,.72),rgba(6,8,16,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}.creator-glow{box-shadow:0 0 28px rgba(255,215,0,.16),inset 0 1px 0 rgba(255,255,255,.05)}`}</style>
    <AnimatePresence>{showAdToast && <motion.div initial={{ opacity:0,y:-18 }} animate={{ opacity:1,y:0 }} exit={{ opacity:0,y:-18 }} className="fixed top-4 left-1/2 z-[90] -translate-x-1/2 rounded-2xl border border-[#00F5FF]/35 bg-black/90 px-5 py-3 shadow-[0_0_30px_rgba(0,245,255,.25)]"><div className="flex items-center gap-2 font-mono text-xs font-black text-[#00F5FF]"><CheckCircle size={15}/>+{showAdToast.tc} TC · {showAdToast.left} ads left</div></motion.div>}</AnimatePresence>
    <div className="mb-4 flex items-center gap-2"><Gift size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]"/><span className="font-mono text-xs tracking-[0.18em] text-white/60 uppercase">Earn Center</span></div>
    <section className="earn-card creator-glow rounded-3xl p-4 mb-4 relative overflow-hidden"><div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-[#FFD700]/14 blur-3xl"/><div className="relative z-10 flex items-center justify-between gap-3"><div><div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#FFD700]">Koinara Rank</div><div className="mt-1 flex items-center gap-2"><Trophy size={22} className="text-[#FFD700]"/><h1 className="text-2xl font-black">Level {current.level} · {current.name}</h1></div><p className="mt-1 font-mono text-[10px] text-white/45">{rankXp.toLocaleString()} XP · Creator XP {creatorXp.toLocaleString()}</p></div><div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/45">Next</div><div className="font-mono text-xs font-black text-[#FFD700]">{next ? next.name : "Max"}</div></div></div><div className="relative z-10 mt-3 h-2 rounded-full bg-white/8 overflow-hidden"><motion.div initial={{ width:0 }} animate={{ width:`${progress}%` }} className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#FF4D8D] to-[#00F5FF]"/></div><div className="relative z-10 mt-2 flex items-center justify-between font-mono text-[9px] text-white/38"><span>Trade cap {current.trade} · Mines {current.mines}</span><span>{next ? `${(next.xp-rankXp).toLocaleString()} XP to level ${next.level}` : "Legend complete"}</span></div></section>
    <section className="grid grid-cols-3 gap-2 mb-4"><div className="earn-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/38 uppercase">Pending</div><div className="text-xl font-black text-[#FFD700]">{creatorStats.pending}</div></div><div className="earn-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/38 uppercase">Approved</div><div className="text-xl font-black text-[#00F5FF]">{creatorStats.approved}</div></div><div className="earn-card rounded-2xl p-3"><div className="font-mono text-[9px] text-white/38 uppercase">VIP refs</div><div className="text-xl font-black text-[#FF4D8D]">{creatorStats.vipRefs}</div></div></section>
    <div className="mb-4 flex gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1"><button onClick={()=>setActiveTab("earn")} className={`flex-1 rounded-xl py-2.5 font-mono text-xs font-black ${activeTab==="earn"?"bg-[#00F5FF]/14 text-[#00F5FF] border border-[#00F5FF]/25":"text-white/35"}`}><Gift size={12} className="inline mr-1"/>Quests</button><button onClick={()=>setActiveTab("creator")} className={`flex-1 rounded-xl py-2.5 font-mono text-xs font-black ${activeTab==="creator"?"bg-[#FFD700]/14 text-[#FFD700] border border-[#FFD700]/25":"text-white/35"}`}><Video size={12} className="inline mr-1"/>Creator</button></div>
    {activeTab === "earn" && <div className="space-y-4"><Link href="/lootbox"><div className="earn-card rounded-2xl p-4 flex items-center justify-between"><div><div className="font-mono text-[10px] text-[#FFD700] tracking-[0.18em] uppercase">Bonus Feature</div><div className="font-black text-lg">Lootbox</div></div><Sparkles className="text-[#FFD700]"/></div></Link><div className="earn-card rounded-3xl p-4 border-[#FF4D8D]/30"><div className="flex items-center justify-between mb-3"><div className="flex items-center gap-3"><Tv size={22} className="text-[#FF4D8D]"/><div><div className="font-black text-lg">Watch Ad</div><div className="font-mono text-[10px] text-white/45">Earn TC without cashout liability</div></div></div><div className="font-mono text-lg font-black text-[#FF4D8D]">+{adTcReward} TC</div></div><div className="mb-3 h-2 rounded-full bg-white/8 overflow-hidden"><div className="h-full rounded-full bg-[#FF4D8D]" style={{width:`${Math.min(100,(adsWatchedToday/adDailyCap)*100)}%`}}/></div><button onClick={handleWatchAd} disabled={adsRemaining<=0||watchAdMutation.isPending} className="w-full rounded-2xl border border-[#FF4D8D]/35 bg-[#FF4D8D]/10 py-3 font-mono text-sm font-black text-[#FF4D8D] disabled:opacity-40"><Play size={14} className="inline mr-2"/>{adsRemaining>0?`Watch · ${adsRemaining}/${adDailyCap} left`:"Daily ad cap reached"}</button></div><div className="earn-card rounded-3xl p-4 border-[#FFD700]/35"><div className="flex items-center gap-3 mb-3"><Crown size={24} className="text-[#FFD700]"/><div><div className="font-black text-lg">VIP Referral Income</div><div className="font-mono text-[10px] text-white/45">Main unlimited creator upside</div></div></div><div className="grid grid-cols-2 gap-2 mb-3"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Creator earns</div><div className="font-black text-[#FFD700]">20% direct</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="font-black text-[#00F5FF]">5% bonus</div></div></div><button onClick={()=>navigator.clipboard.writeText(referralLink)} className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Share2 size={14} className="inline mr-2"/>Copy Invite Link</button></div></div>}
    {activeTab === "creator" && <div className="space-y-4"><div className="earn-card rounded-3xl p-4 border-[#FFD700]/35"><div className="flex items-center gap-3 mb-3"><Rocket size={24} className="text-[#FFD700]"/><div><div className="font-black text-xl">Creator Missions</div><div className="font-mono text-[10px] text-white/45">WhatsApp, Reels, YouTube, and real referrals.</div></div></div><div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]">Put this in your caption, bio, pinned comment, or video: <b>{creatorCode}</b></div></div><div className="grid grid-cols-1 gap-2">{REWARD_TIERS.map((tier,index)=><div key={tier.label} className="earn-card rounded-2xl p-3 flex items-center gap-3"><div className="h-9 w-9 rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/10 flex items-center justify-center font-black text-[#FFD700]">{index+1}</div><div className="flex-1"><div className="font-black">{tier.label}</div><div className="font-mono text-[10px] text-white/40">{tier.note}</div></div><div className="font-mono text-xs font-black text-[#FFD700] text-right">{tier.reward}</div></div>)}</div><div className="earn-card rounded-3xl border-[#FF4D8D]/35 p-4"><div className="mb-2 flex items-center gap-2"><ShieldAlert size={16} className="text-[#FF4D8D]"/><span className="font-mono text-xs font-black text-[#FF4D8D] uppercase tracking-[0.14em]">Fair-play warning</span></div><p className="font-mono text-[10px] leading-relaxed text-white/48">Fake views, duplicate content, stolen videos, self-referrals, bot traffic, or fake proof can lead to permanent ban and lost rewards. Real creators get protected.</p></div><div className="earn-card rounded-3xl p-4"><div className="font-black text-lg mb-3">Submit proof</div><div className="mb-3 grid grid-cols-4 gap-1.5">{PLATFORMS.map(p=><button key={p.id} onClick={()=>{setPlatform(p.id); if(p.id==="whatsapp") setPostType("story"); if(p.id==="youtube") setPostType("long");}} className={`rounded-xl py-2 font-mono text-[10px] font-black border ${platform===p.id?"border-[#00F5FF] bg-[#00F5FF]/12 text-[#00F5FF]":"border-white/10 text-white/35"}`}>{p.label}</button>)}</div><div className="mb-3 grid grid-cols-4 gap-1.5">{POST_TYPES.map(p=><button key={p.id} onClick={()=>setPostType(p.id)} className={`rounded-xl py-2 border ${postType===p.id?"border-[#FFD700] bg-[#FFD700]/12 text-[#FFD700]":"border-white/10 text-white/35"}`}><div className="font-mono text-[10px] font-black">{p.label}</div><div className="font-mono text-[8px] opacity-60">{p.hint}</div></button>)}</div><input value={contentUrl} onChange={(e)=>setContentUrl(e.target.value)} placeholder="Paste WhatsApp proof / Reel / YouTube link" className="mb-2 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-xs text-white outline-none focus:border-[#00F5FF]/50"/><input value={caption} onChange={(e)=>setCaption(e.target.value)} placeholder="Caption / proof text" className="mb-3 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-xs text-white outline-none focus:border-[#FFD700]/50"/>{feedback&&<div className={`mb-3 rounded-2xl border px-3 py-2 font-mono text-[10px] ${feedback.ok?"border-[#00F5FF]/30 bg-[#00F5FF]/8 text-[#00F5FF]":"border-[#FF4D8D]/30 bg-[#FF4D8D]/8 text-[#FF4D8D]"}`}>{feedback.ok?<CheckCircle size={12} className="inline mr-1"/>:<AlertCircle size={12} className="inline mr-1"/>}{feedback.msg}</div>}<button onClick={handleSubmitContent} disabled={!contentUrl.trim()||submitting} className="w-full rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FF4D8D] py-3 font-black text-black disabled:opacity-45"><Send size={14} className="inline mr-2"/>{submitting?"Submitting...":"Submit for Review"}</button><p className="mt-2 text-center font-mono text-[9px] text-white/28">Views alone do not guarantee rewards. Real signups and VIP referrals matter most.</p></div>{submissions.length>0&&<div className="space-y-2"><div className="font-mono text-[10px] text-white/40 tracking-[0.18em] uppercase">Your submissions</div>{submissions.slice(0,6).map(sub=><div key={sub.id} className="earn-card rounded-2xl p-3 flex items-center gap-3"><Video size={18} className="text-[#FFD700]"/><div className="flex-1 min-w-0"><div className="truncate font-mono text-[10px] text-white/60">{sub.url}</div><div className="font-mono text-[9px] text-white/30 capitalize">{sub.platform} · {sub.postType??"post"}</div></div><div className={`rounded-full px-2 py-1 font-mono text-[9px] font-black ${sub.status==="approved"?"bg-[#00F5FF]/10 text-[#00F5FF]":sub.status==="rejected"?"bg-[#FF4D8D]/10 text-[#FF4D8D]":"bg-[#FFD700]/10 text-[#FFD700]"}`}>{sub.status}</div></div>)}</div>}</div>}
  </div>;
}

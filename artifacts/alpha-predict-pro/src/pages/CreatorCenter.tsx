import { useEffect, useMemo, useState } from "react";
import { CheckCircle, Copy, Crown, ExternalLink, Lock, Rocket, Send, ShieldCheck, Share2, Trophy, Users, Video, Wallet } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const USD_TO_INR_EST = 83;
const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const CREATOR_PASS_USD = 0.99;
const CREATOR_PASS_INR = 82;
const CREATOR_PASS_TON = 0.2;

const CREATOR_RANKS = [
  { name: "Starter", min: 0, next: 3, tone: "#8BC3FF", perk: "Creator link + content access after pass" },
  { name: "Bronze", min: 3, next: 10, tone: "#FFD700", perk: "Bronze creator badge" },
  { name: "Silver", min: 10, next: 25, tone: "#00F5FF", perk: "Higher creator visibility" },
  { name: "Gold", min: 25, next: 100, tone: "#FF4D8D", perk: "Priority content review" },
  { name: "Elite", min: 100, next: null, tone: "#B65CFF", perk: "Top creator status" },
];

const REWARD_TIERS = [
  { views: "1K views", reward: "TC + creator XP review", note: "real views only" },
  { views: "10K views", reward: "higher GC/TC review", note: "engagement checked" },
  { views: "100K views", reward: "premium reward review", note: "owner verifies" },
  { views: "1M views", reward: "elite campaign review", note: "manual approval" },
];

type CreatorSubmission = { id: number | string; platform?: string; postType?: string; url: string; status: string; gcAwarded?: number; createdAt?: string };
type Platform = "whatsapp" | "instagram" | "youtube" | "tiktok" | "x";
type PostType = "story" | "post" | "short" | "long";

function apiBase() {
  return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
}

function usdForGc(gc: number, rate: number): number {
  return gc / rate;
}

function moneyFromGc(gc: number, rate: number): string {
  const usd = usdForGc(gc, rate);
  return `$${usd.toFixed(2)} / ₹${Math.round(usd * USD_TO_INR_EST).toLocaleString()}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function CreatorCenter() {
  const { user } = useTelegram();
  const u = user as any;
  const vip = isVipActive(user);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contentUrl, setContentUrl] = useState("");
  const [platform, setPlatform] = useState<Platform>("whatsapp");
  const [postType, setPostType] = useState<PostType>("story");
  const [submitting, setSubmitting] = useState(false);
  const [submissions, setSubmissions] = useState<CreatorSubmission[]>([]);

  const creatorPassActive = vip || !!u?.creatorPassPaid;
  const creatorPassMissingBackend = !vip && typeof u?.creatorPassPaid === "undefined";
  const gcPerUsd = vip ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  const level1Count = u?.directReferralCount ?? u?.referralCount ?? 0;
  const level2Count = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const paidReferralCount = u?.paidReferralCount ?? 0;
  const vipReferralCount = u?.vipReferralCount ?? 0;
  const directCommissionGc = u?.directCommissionGc ?? 0;
  const networkCommissionGc = u?.level2CommissionGc ?? u?.networkCommissionGc ?? 0;
  const totalCreatorGc = u?.referralEarnings ?? u?.referralEarningsGc ?? directCommissionGc + networkCommissionGc;
  const pendingCreatorGc = u?.pendingCreatorGc ?? 0;
  const withdrawableCreatorGc = u?.withdrawableCreatorGc ?? totalCreatorGc;
  const activeReferrals = level1Count + level2Count;

  const rank = useMemo(() => [...CREATOR_RANKS].reverse().find((r) => activeReferrals >= r.min) ?? CREATOR_RANKS[0], [activeReferrals]);
  const nextRank = rank.next ? CREATOR_RANKS.find((r) => r.min === rank.next) : null;
  const progress = rank.next ? Math.min(100, Math.round(((activeReferrals - rank.min) / (rank.next - rank.min)) * 100)) : 100;

  const fetchSubmissions = async () => {
    if (!user?.telegramId) return;
    try {
      const initData = window.Telegram?.WebApp?.initData ?? "";
      const res = await fetch(`${apiBase()}/api/content/${user.telegramId}`, { headers: initData ? { "x-telegram-init-data": initData } : {} });
      if (!res.ok) return;
      const data = await res.json();
      setSubmissions(Array.isArray(data?.submissions) ? data.submissions : []);
    } catch {}
  };

  useEffect(() => { fetchSubmissions(); }, [user?.telegramId]);

  const handleCopyInvite = async () => {
    if (!referralLink) return;
    const ok = await copyText(referralLink);
    setCopied(ok ? "link" : null);
    setNotice(ok ? "Creator link copied." : "Copy failed. Use Telegram share.");
    window.setTimeout(() => { setCopied(null); setNotice(null); }, 1600);
  };

  const handleShareTelegram = () => {
    if (!referralLink) return;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join me on Koinara. Creator Pass lets users earn from verified referral purchases and approved content.")}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  const handleUnavailablePayment = (method: string) => {
    setNotice(`${method} Creator Pass checkout needs backend payment verification before launch.`);
    window.setTimeout(() => setNotice(null), 3200);
  };

  const handleSubmitContent = async () => {
    if (!user?.telegramId || !contentUrl.trim() || !creatorPassActive) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const initData = window.Telegram?.WebApp?.initData ?? "";
      const res = await fetch(`${apiBase()}/api/content/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(initData ? { "x-telegram-init-data": initData } : {}) },
        body: JSON.stringify({ telegramId: user.telegramId, platform, postType, url: contentUrl.trim(), caption: `Koinara Creator Pass ${creatorCode}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Submission failed");
      setContentUrl("");
      setNotice(data?.message ?? "Content submitted. Review pending.");
      fetchSubmissions();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Content submission failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.creator-card{background:linear-gradient(160deg,rgba(13,24,44,.78),rgba(5,6,12,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}`}</style>

    <div className="mb-4 flex items-center gap-2"><Rocket size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Creator</span><Link href="/earn"><span className="ml-auto rounded-full border border-[#00F5FF]/25 bg-[#00F5FF]/10 px-3 py-1 font-mono text-[10px] font-black text-[#00F5FF]">Earn</span></Link></div>
    {notice && <div className="mb-4 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-[#FFD700]">{notice}</div>}

    <section className="creator-card relative mb-4 overflow-hidden rounded-3xl p-4">
      <div className="absolute -right-14 -top-16 h-44 w-44 rounded-full bg-[#FFD700]/15 blur-3xl"/>
      <div className="relative z-10">
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-2.5 py-1 font-mono text-[9px] font-black uppercase tracking-[0.16em] text-[#FFE266]"><Rocket size={11}/>Koinara Creator Pass</div>
        <h1 className="text-3xl font-black leading-tight">Your creator business starts here</h1>
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-white/48">Buy Creator Pass, invite real users, earn commissions from verified purchases, and submit approved Koinara content. Estimated only. Not guaranteed.</p>
      </div>
    </section>

    {!creatorPassActive ? <section className="creator-card mb-4 rounded-3xl border-[#FFD700]/35 p-4">
      <div className="mb-3 flex items-start justify-between gap-3"><div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Koinara Creator Pass</div><div className="mt-1 text-3xl font-black">${CREATOR_PASS_USD.toFixed(2)} / ₹{CREATOR_PASS_INR}</div><div className="mt-1 font-mono text-[10px] text-white/42">Monthly creator access · 0.2 TON option</div></div><div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-2 text-right"><Lock size={18} className="ml-auto text-[#FFD700]"/><div className="font-mono text-[9px] text-white/38">Status</div><div className="font-mono text-xs font-black text-[#FFD700]">Locked</div></div></div>
      <div className="mb-3 space-y-2 font-mono text-[11px] text-white/65">{["Personal referral link activated", "20% commission on every referral purchase", "5% on your network's referrals", "Content submission unlocked"].map((item) => <div key={item} className="flex gap-2"><CheckCircle size={13} className="mt-0.5 shrink-0 text-[#00F5A0]"/><span>{item}</span></div>)}</div>
      <div className="mb-3 rounded-3xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[10px] leading-relaxed text-white/62"><div>Refer 1 VIP user → earn $1.198/month while active</div><div>Refer 5 VIP users → earn $5.99/month while active</div><div>Refer 10 VIP users → earn $11.98/month while active</div><div className="mt-2 text-white/35">Estimated. Not guaranteed. Based on verified referral activity and payment confirmation.</div></div>
      <div className="grid grid-cols-2 gap-2"><button onClick={() => handleUnavailablePayment("Stars")} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black">Pay $0.99 with Stars</button><button onClick={() => handleUnavailablePayment("TON")} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]">Pay {CREATOR_PASS_TON} TON</button></div>
      {creatorPassMissingBackend && <p className="mt-3 font-mono text-[9px] leading-relaxed text-[#FFD700]/70">TODO backend: add creatorPassPaid + creatorPassPaidAt, then wire successful Stars/TON checkout. Showing locked because real backend status is not available yet.</p>}
    </section> : <section className="creator-card mb-4 rounded-3xl border-[#00F5A0]/35 p-4"><div className="flex items-center gap-2 text-[#00F5A0]"><CheckCircle size={18}/><span className="font-black">Creator Pass Active ✓</span></div><p className="mt-2 font-mono text-[10px] text-white/45">Your creator link, commissions, content access, and rank dashboard are active.</p></section>}

    {creatorPassActive && <>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Section 1 — Your Creator Link</div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] break-all text-white/50">{referralLink}</div><div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]">Creator code: <b>{creatorCode}</b></div><div className="grid grid-cols-2 gap-2"><button onClick={handleCopyInvite} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Copy size={14} className="inline mr-2"/>{copied === "link" ? "Copied" : "Copy Link"}</button><button onClick={handleShareTelegram} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="inline mr-2"/>Share to Telegram</button></div></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Section 2 — Commission Earnings</div><div className="grid grid-cols-3 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 1</div><div className="text-xl font-black text-[#FFD700]">{directCommissionGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/35">{moneyFromGc(directCommissionGc, gcPerUsd)}</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="text-xl font-black text-[#00F5FF]">{networkCommissionGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/35">{moneyFromGc(networkCommissionGc, gcPerUsd)}</div></div><div className="rounded-2xl border border-[#00F5A0]/18 bg-[#00F5A0]/8 p-3"><div className="font-mono text-[9px] text-white/38">Total</div><div className="text-xl font-black text-[#00F5A0]">{totalCreatorGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/35">{moneyFromGc(totalCreatorGc, gcPerUsd)}</div></div></div><Link href="/wallet"><button className="mt-3 w-full rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/10 py-3 font-black text-[#FFD700]"><Wallet size={14} className="inline mr-2"/>Withdraw to Wallet</button></Link><p className="mt-3 font-mono text-[9px] leading-relaxed text-white/35">Commissions credited after payment confirmation. Reviewed before withdrawal.</p></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Section 3 — Your Network</div><div className="grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 1 referrals</div><div className="text-2xl font-black text-[#FFD700]">{level1Count}</div><div className="font-mono text-[8px] text-white/35">active users</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/38">Level 2 referrals</div><div className="text-2xl font-black text-[#00F5FF]">{level2Count}</div><div className="font-mono text-[8px] text-white/35">network users</div></div><div className="rounded-2xl border border-[#00F5A0]/18 bg-[#00F5A0]/8 p-3"><div className="font-mono text-[9px] text-white/38">Purchased</div><div className="text-2xl font-black text-[#00F5A0]">{paidReferralCount}</div><div className="font-mono text-[8px] text-white/35">TODO if zero</div></div><div className="rounded-2xl border border-[#FF4D8D]/18 bg-[#FF4D8D]/8 p-3"><div className="font-mono text-[9px] text-white/38">VIP referrals</div><div className="text-2xl font-black text-[#FF4D8D]">{vipReferralCount}</div><div className="font-mono text-[8px] text-white/35">monthly buyers</div></div></div></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center justify-between"><div className="font-black text-xl">Section 4 — Content Submissions</div><button onClick={() => document.getElementById("creator-submit")?.scrollIntoView({ behavior: "smooth" })} className="rounded-full border border-[#00F5FF]/25 bg-[#00F5FF]/10 px-3 py-1 font-mono text-[10px] font-black text-[#00F5FF]">Submit New</button></div>{submissions.length === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">No submissions yet.</div> : <div className="space-y-2">{submissions.slice(0, 6).map((sub) => <div key={sub.id} className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="flex items-center gap-3"><Video size={16} className="text-[#FFD700]"/><div className="min-w-0 flex-1"><div className="truncate font-mono text-[10px] text-white/58">{sub.url}</div><div className="font-mono text-[9px] text-white/30">{sub.platform ?? "content"} · {sub.postType ?? "post"}</div></div><span className="rounded-full bg-[#FFD700]/10 px-2 py-1 font-mono text-[9px] font-black text-[#FFD700]">{sub.status}</span></div></div>)}</div>}<div className="mt-3 space-y-2">{REWARD_TIERS.map((tier) => <div key={tier.views} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div><div className="font-black text-sm">{tier.views}</div><div className="font-mono text-[9px] text-white/35">{tier.note}</div></div><div className="font-mono text-[10px] font-black text-[#FFD700]">{tier.reward}</div></div>)}</div></section>

      <section id="creator-submit" className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Submit New Content</div><div className="mb-3 grid grid-cols-4 gap-1.5">{(["whatsapp", "instagram", "youtube", "tiktok"] as Platform[]).map((p) => <button key={p} onClick={() => setPlatform(p)} className={`rounded-xl border py-2 font-mono text-[10px] font-black capitalize ${platform === p ? "border-[#00F5FF] bg-[#00F5FF]/12 text-[#00F5FF]" : "border-white/10 text-white/35"}`}>{p}</button>)}</div><div className="mb-3 grid grid-cols-4 gap-1.5">{(["story", "short", "long", "post"] as PostType[]).map((p) => <button key={p} onClick={() => setPostType(p)} className={`rounded-xl border py-2 font-mono text-[10px] font-black capitalize ${postType === p ? "border-[#FFD700] bg-[#FFD700]/12 text-[#FFD700]" : "border-white/10 text-white/35"}`}>{p}</button>)}</div><input value={contentUrl} onChange={(e) => setContentUrl(e.target.value)} placeholder="Paste content/proof URL" className="mb-3 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 font-mono text-xs text-white outline-none focus:border-[#00F5FF]/50"/><button onClick={handleSubmitContent} disabled={!contentUrl.trim() || submitting} className="w-full rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FF4D8D] py-3 font-black text-black disabled:opacity-45"><Send size={14} className="inline mr-2"/>{submitting ? "Submitting..." : "Submit for Review"}</button></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Trophy size={18} style={{ color: rank.tone }}/><span className="font-black text-xl">Section 5 — Creator Rank</span></div><div className="mb-2 flex items-center justify-between"><div className="text-2xl font-black">{rank.name}</div><div className="font-mono text-[10px] text-white/38">{nextRank ? `${Math.max(0, rank.next! - activeReferrals)} referrals to ${nextRank.name}` : "Elite reached"}</div></div><div className="h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#FF4D8D] to-[#00F5FF]" style={{ width: `${progress}%` }}/></div><div className="mt-3 rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]">Current perk: {rank.perk}</div></section>
    </>}

    <section className="rounded-3xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-4"><div className="mb-2 flex items-center gap-2 text-[#00F5A0]"><ShieldCheck size={18}/><span className="font-black">Trust rules</span></div><div className="space-y-2 font-mono text-[10px] leading-relaxed text-white/50">{["Creator Pass is not guaranteed income.", "Commissions require successful payment confirmation.", "Fake accounts, self-referrals, bot traffic, fake views, or stolen content can be rejected.", "Creator earnings withdraw the same way as gameplay GC through Wallet."].map((rule) => <div key={rule} className="flex gap-2"><CheckCircle size={12} className="mt-0.5 shrink-0 text-[#00F5A0]"/><span>{rule}</span></div>)}</div></section>
  </div>;
}

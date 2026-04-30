import { useEffect, useState } from "react";
import { CheckCircle, Copy, Rocket, Share2, Wallet } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

type Summary = {
  creatorPassPaid?: boolean;
  creatorCredits?: number;
  totalCrEarned?: number;
  pendingCr?: number;
  withdrawableCr?: number;
  directReferralCount?: number;
  level2ReferralCount?: number;
  vipReferralCount?: number;
  networkPurchaseCount?: number;
  directCommissionCr?: number;
  networkCommissionCr?: number;
  renewalCommissionCr?: number;
  contentRewardCr?: number;
};

type Leader = { rank: number; telegramId: string; username?: string | null; firstName?: string | null; totalCrEarned?: number };

const CR_PER_USD = 1000;
function apiBase() { return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""; }
function headers() { const initData = window.Telegram?.WebApp?.initData ?? ""; return initData ? { "x-telegram-init-data": initData } : {}; }
function crUsd(cr: number) { return `$${(cr / CR_PER_USD).toFixed(2)}`; }
function name(row: Leader) { return row.username ? `@${row.username}` : row.firstName || `Creator ${row.telegramId.slice(-4)}`; }
async function copyText(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

export default function CreatorCenter() {
  const { user } = useTelegram();
  const vip = isVipActive(user);
  const u = user as any;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const creatorActive = vip || !!u?.creatorPassPaid || !!summary?.creatorPassPaid;
  const cr = summary?.creatorCredits ?? u?.creatorCredits ?? 0;
  const pendingCr = summary?.pendingCr ?? 0;
  const withdrawableCr = summary?.withdrawableCr ?? 0;
  const totalCr = summary?.totalCrEarned ?? u?.totalCrEarned ?? 0;
  const directRefs = summary?.directReferralCount ?? u?.directReferralCount ?? u?.referralCount ?? 0;
  const level2Refs = summary?.level2ReferralCount ?? u?.level2ReferralCount ?? 0;
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  useEffect(() => {
    if (!user?.telegramId) return;
    const load = async () => {
      try {
        const s = await fetch(`${apiBase()}/api/creator/${user.telegramId}/cr-summary`, { headers: headers() });
        if (s.ok) setSummary(await s.json());
        const l = await fetch(`${apiBase()}/api/creator/leaderboard`, { headers: headers() });
        if (l.ok) { const data = await l.json(); setLeaders(Array.isArray(data?.rows) ? data.rows : []); }
      } catch {}
    };
    load();
  }, [user?.telegramId]);

  const copyLink = async () => {
    const ok = referralLink ? await copyText(referralLink) : false;
    setNotice(ok ? "Creator link copied." : "Copy failed. Use Telegram share.");
    window.setTimeout(() => setNotice(null), 1600);
  };

  const share = () => {
    if (!referralLink) return;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent("Join my Koinara creator network.")}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.creator-card{background:linear-gradient(160deg,rgba(13,24,44,.78),rgba(5,6,12,.96));border:1px solid rgba(0,245,160,.2);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}`}</style>
    <div className="mb-4 flex items-center gap-2"><Rocket size={16} className="text-[#00F5A0]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Creator</span></div>
    {notice && <div className="mb-4 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-[#00F5A0]">{notice}</div>}

    <section className="creator-card mb-4 rounded-3xl p-4"><h1 className="text-3xl font-black text-[#00F5A0]">Creator Credits</h1><p className="mt-2 font-mono text-[11px] leading-relaxed text-white/48">CR is separate from TC and GC. 1,000 CR = $1.00 USDT. Rewards are reviewed before withdrawal.</p></section>

    {!creatorActive && <section className="creator-card mb-4 rounded-3xl p-4"><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Koinara Creator Pass</div><div className="mt-1 text-3xl font-black">$0.99 / ₹82</div><p className="mt-2 font-mono text-[11px] text-white/48">Activates creator tools, referral link, CR dashboard, and content submission access.</p><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => setNotice("Stars checkout needs backend verification wiring before launch.")} className="rounded-2xl bg-[#00F5A0] py-3 font-black text-black">Pay with Stars</button><button onClick={() => setNotice("TON checkout needs backend verification wiring before launch.")} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]">Pay 0.2 TON</button></div></section>}

    {creatorActive && <>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">CR Balance</div><div className="mt-1 text-4xl font-black text-[#00F5A0]">{cr.toLocaleString()} CR</div><div className="mt-1 font-mono text-xs text-white/50">Available: {withdrawableCr.toLocaleString()} CR · {crUsd(withdrawableCr)}</div><div className="mt-1 font-mono text-[10px] text-white/35">Pending review: {pendingCr.toLocaleString()} CR</div>{cr === 0 && totalCr === 0 && <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 font-mono text-[10px] text-white/42">Your CR balance will appear here after your first verified creator activity.</div>}<Link href="/wallet"><button className="mt-3 w-full rounded-2xl bg-[#00F5A0] py-3 font-black text-black"><Wallet size={14} className="inline mr-2"/>Withdraw CR</button></Link><p className="mt-2 font-mono text-[9px] text-white/35">Min 1,000 CR · 10% fee · no daily cap</p></section>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Creator Link</div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] break-all text-white/50">{referralLink}</div><div className="mb-3 rounded-2xl border border-[#00F5A0]/20 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-[#00F5A0]">Creator code: <b>{creatorCode}</b></div><div className="grid grid-cols-2 gap-2"><button onClick={copyLink} className="rounded-2xl bg-[#00F5A0] py-3 font-black text-black"><Copy size={14} className="inline mr-2"/>Copy</button><button onClick={share} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="inline mr-2"/>Share</button></div></section>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Breakdown</div><div className="grid grid-cols-2 gap-2">{[["Level 1", summary?.directCommissionCr ?? 0], ["Level 2", summary?.networkCommissionCr ?? 0], ["Renewals", summary?.renewalCommissionCr ?? 0], ["Content", summary?.contentRewardCr ?? 0]].map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-[#00F5A0]/15 bg-[#00F5A0]/7 p-3"><div className="font-mono text-[9px] text-white/38">{label}</div><div className="text-xl font-black text-[#00F5A0]">{Number(value).toLocaleString()} CR</div><div className="font-mono text-[8px] text-white/35">{Number(value) > 0 ? crUsd(Number(value)) : "—"}</div></div>)}</div></section>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Network</div><div className="grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Direct referrals</div><div className="text-2xl font-black">{directRefs}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Network referrals</div><div className="text-2xl font-black">{level2Refs}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">VIP referrals</div><div className="text-2xl font-black">{summary?.vipReferralCount ?? 0}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Network purchases</div><div className="text-2xl font-black">{summary?.networkPurchaseCount ?? 0}</div></div></div></section>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Top CR Earners</div>{leaders.length === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">No verified creator earners yet.</div> : <div className="space-y-2">{leaders.map((row) => <div key={row.telegramId} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="h-9 w-9 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/10 text-[#00F5A0] flex items-center justify-center font-black">#{row.rank}</div><div className="min-w-0 flex-1"><div className="truncate font-mono text-xs font-black text-white">{name(row)}</div><div className="font-mono text-[9px] text-white/35">Real CR leaderboard</div></div><div className="text-right"><div className="font-mono text-xs font-black text-[#00F5A0]">{(row.totalCrEarned ?? 0).toLocaleString()} CR</div><div className="font-mono text-[9px] text-white/35">{crUsd(row.totalCrEarned ?? 0)}</div></div></div>)}</div>}</section>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">How CR works</div>{["CR comes from reviewed creator activity.", "1,000 CR = $1.00 USDT.", "Withdraw above 1,000 CR.", "10% withdrawal fee applies.", "Commissions approve after 48 hour review."].map((rule) => <div key={rule} className="mb-2 flex gap-2 font-mono text-[10px] text-white/50"><CheckCircle size={12} className="mt-0.5 text-[#00F5A0]"/><span>{rule}</span></div>)}</section>
    </>}
  </div>;
}

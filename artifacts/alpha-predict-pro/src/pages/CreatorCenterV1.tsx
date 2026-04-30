import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, ChevronDown, Copy, Crown, DollarSign, Eye, Gift, IndianRupee, Rocket, Share2, ShieldCheck, Sparkles, Trophy, Users, Wallet } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const CREATOR_PASS_USD = 0.99;
const USD_TO_INR = 83;
const GC_PER_USD = 4000;
const FREE_L1 = 0.1;
const FREE_L2 = 0.02;
const VIP_L1 = 0.2;
const VIP_L2 = 0.05;

const RANKS = [
  { name: "Starter", min: 0, next: 3, tone: "#8BC3FF" },
  { name: "Bronze", min: 3, next: 25, tone: "#D98A3A" },
  { name: "Silver", min: 25, next: 100, tone: "#D6E4FF" },
  { name: "Gold", min: 100, next: 500, tone: "#FFD700" },
  { name: "Diamond", min: 500, next: 2000, tone: "#00F5FF" },
  { name: "Crown", min: 2000, next: null, tone: "#FF4D8D" },
];

function usd(value: number): string { return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function inr(value: number): string { return `₹${Math.round(value * USD_TO_INR).toLocaleString()}`; }
function compact(value: number): string { return value.toLocaleString(undefined, { maximumFractionDigits: 0 }); }

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard?.writeText(text); return true; } catch {}
  try {
    const input = document.createElement("textarea");
    input.value = text; input.style.position = "fixed"; input.style.opacity = "0";
    document.body.appendChild(input); input.focus(); input.select();
    const ok = document.execCommand("copy"); document.body.removeChild(input); return ok;
  } catch { return false; }
}

function rankFor(active: number) {
  return [...RANKS].reverse().find((rank) => active >= rank.min) ?? RANKS[0];
}

export default function CreatorCenterV1() {
  const { user } = useTelegram();
  const u = user as any;
  const vip = isVipActive(user);
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showPotential, setShowPotential] = useState(false);

  const level1 = u?.referralCount ?? u?.directReferralCount ?? 0;
  const level2 = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const activeReferrals = level1 + level2;
  const creatorGc = u?.creatorBalanceGc ?? u?.referralEarningsGc ?? u?.referralEarnings ?? 0;
  const creatorUsd = creatorGc / GC_PER_USD;
  const creatorInr = creatorUsd * USD_TO_INR;
  const rank = rankFor(activeReferrals);
  const nextNeeded = rank.next ? Math.max(0, rank.next - activeReferrals) : 0;
  const rankProgress = rank.next ? Math.min(100, ((activeReferrals - rank.min) / (rank.next - rank.min)) * 100) : 100;
  const l1Rate = vip ? VIP_L1 : FREE_L1;
  const l2Rate = vip ? VIP_L2 : FREE_L2;
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";

  const potential = useMemo(() => {
    const activeBase = Math.max(activeReferrals, 10);
    const conservativeVip = Math.max(1, Math.round(activeBase * 0.08));
    const strongVip = Math.max(3, Math.round(activeBase * 0.18));
    const viralVip = Math.max(8, Math.round(activeBase * 0.35));
    const calc = (directVip: number, secondVip: number) => directVip * CREATOR_PASS_USD * l1Rate + secondVip * CREATOR_PASS_USD * l2Rate;
    return [
      { label: "Starter month", users: conservativeVip, usd: calc(conservativeVip, Math.round(conservativeVip * 2)), note: "small friend group" },
      { label: "Active month", users: strongVip, usd: calc(strongVip, Math.round(strongVip * 4)), note: "posting + sharing" },
      { label: "Viral month", users: viralVip, usd: calc(viralVip, Math.round(viralVip * 8)), note: "creator content hits" },
    ];
  }, [activeReferrals, l1Rate, l2Rate]);

  const handleCopy = async () => {
    if (!referralLink) return;
    const ok = await copyText(referralLink);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2200);
  };

  const handleShare = () => {
    const text = `I am building my Koinara Creator network. Join with my invite and start earning rewards.`;
    const url = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(text)}`;
    window.Telegram?.WebApp?.openTelegramLink?.(url) ?? window.open(url, "_blank");
  };

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.creator-card{background:linear-gradient(160deg,rgba(15,24,42,.82),rgba(5,8,16,.95));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}.creator-blue{background:linear-gradient(160deg,rgba(0,245,255,.12),rgba(9,12,22,.94));border:1px solid rgba(0,245,255,.22)}.creator-pink{background:linear-gradient(160deg,rgba(255,77,141,.12),rgba(9,12,22,.94));border:1px solid rgba(255,77,141,.22)}`}</style>

    <div className="mb-4 flex items-center justify-between">
      <div className="flex items-center gap-2"><Rocket size={17} className="text-[#FFD700]" /><span className="font-mono text-xs tracking-[0.2em] uppercase text-white/55">Creator Center</span></div>
      <Link href="/earn" className="font-mono text-[10px] text-white/35">Earn</Link>
    </div>

    <section className="creator-card relative mb-4 overflow-hidden rounded-3xl p-5">
      <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-[#FFD700]/16 blur-3xl" />
      <div className="relative z-10">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] font-black uppercase tracking-[0.2em] text-[#FFD700]"><Wallet size={13} />Creator Balance</div>
        <div className="flex items-end gap-2"><h1 className="text-5xl font-black tracking-tight text-white">{inr(creatorUsd)}</h1><span className="pb-2 font-mono text-sm text-white/38">{usd(creatorUsd)}</span></div>
        <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/45">Separate from game coins. This is your creator rewards lane.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={handleCopy} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Copy size={14} className="mr-2 inline" />{copied ? "Copied" : "Copy Invite"}</button>
          <button onClick={handleShare} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="mr-2 inline" />Share Card</button>
        </div>
      </div>
    </section>

    <section className="mb-4 grid grid-cols-2 gap-3">
      <div className="creator-card rounded-3xl p-4"><div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/38"><Users size={13} />Active Referrals</div><div className="text-3xl font-black text-[#00F5FF]">{compact(activeReferrals)}</div><p className="mt-1 font-mono text-[9px] text-white/30">people in your network</p></div>
      <div className="creator-card rounded-3xl p-4"><div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/38"><Trophy size={13} />Creator Rank</div><div className="text-3xl font-black" style={{ color: rank.tone }}>{rank.name}</div><p className="mt-1 font-mono text-[9px] text-white/30">{rank.next ? `${nextNeeded} to next rank` : "top creator lane"}</p></div>
    </section>

    <section className="creator-card mb-4 rounded-3xl p-4">
      <div className="mb-3 flex items-center justify-between"><div><div className="font-black text-lg">Next rank progress</div><div className="font-mono text-[10px] text-white/38">Invite active users, not empty clicks.</div></div><div className="font-mono text-xs font-black text-[#FFD700]">{Math.round(rankProgress)}%</div></div>
      <div className="h-2 overflow-hidden rounded-full bg-white/8"><motion.div initial={{ width: 0 }} animate={{ width: `${rankProgress}%` }} className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#00F5FF] to-[#FF4D8D]" /></div>
    </section>

    <section className="creator-card mb-4 rounded-3xl p-4">
      <div className="mb-3 flex items-center justify-between"><div><div className="font-black text-xl">Monthly potential</div><p className="font-mono text-[10px] text-white/40">Example earnings from Creator Pass referrals.</p></div><button onClick={() => setShowPotential((v) => !v)} className="rounded-full border border-white/10 bg-white/5 p-2"><ChevronDown size={15} className={`transition ${showPotential ? "rotate-180" : ""}`} /></button></div>
      <div className="grid gap-2">
        {potential.map((row) => <div key={row.label} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className="flex items-center justify-between"><div><div className="font-black text-white">{row.label}</div><div className="font-mono text-[9px] text-white/32">{row.users} VIP referrals · {row.note}</div></div><div className="text-right"><div className="font-black text-[#FFD700]">{usd(row.usd)}</div><div className="font-mono text-[9px] text-white/36">{inr(row.usd)}</div></div></div></div>)}
      </div>
      <AnimatePresence>{showPotential && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><div className="mt-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-white/45">These are examples, not guarantees. Your income depends on real users, verified purchases, anti-fraud checks, and withdrawal approval.</div></motion.div>}</AnimatePresence>
    </section>

    <section className="creator-blue mb-4 rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-3"><Crown size={24} className="text-[#FFD700]" /><div><div className="font-black text-lg">Upgrade to VIP Creator</div><div className="font-mono text-[10px] text-white/42">Higher creator reward rates.</div></div></div>
      <div className="mb-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className="font-mono text-[9px] text-white/35">Free Creator</div><div className="font-black text-white">10% + 2%</div></div><div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/10 p-3"><div className="font-mono text-[9px] text-white/35">VIP Creator</div><div className="font-black text-[#FFD700]">20% + 5%</div></div></div>
      <Link href="/wallet"><button className="w-full rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB000] py-3 font-black text-black">Unlock VIP Creator</button></Link>
    </section>

    <section className="creator-card mb-4 rounded-3xl p-4">
      <button onClick={() => setShowDetails((v) => !v)} className="flex w-full items-center justify-between"><div className="text-left"><div className="font-black text-lg">Referral details</div><div className="font-mono text-[10px] text-white/38">Hidden by default to keep things simple.</div></div><ChevronDown size={16} className={`transition ${showDetails ? "rotate-180" : ""}`} /></button>
      <AnimatePresence>{showDetails && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/35">Level 1</div><div className="text-2xl font-black text-[#FFD700]">{compact(level1)}</div><div className="font-mono text-[9px] text-white/32">direct users · {(l1Rate * 100).toFixed(0)}%</div></div><div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3"><div className="font-mono text-[9px] text-white/35">Level 2</div><div className="text-2xl font-black text-[#00F5FF]">{compact(level2)}</div><div className="font-mono text-[9px] text-white/32">network users · {(l2Rate * 100).toFixed(0)}%</div></div></div></motion.div>}</AnimatePresence>
    </section>

    <section className="creator-pink rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-3"><ShieldCheck size={22} className="text-[#FF4D8D]" /><div><div className="font-black text-lg">Trust rules</div><div className="font-mono text-[10px] text-white/42">Real users only. No fake loops.</div></div></div>
      <div className="space-y-2 font-mono text-[10px] leading-relaxed text-white/45"><p>Creator rewards come from verified users and verified purchases.</p><p>Fake accounts, duplicate wallets, self-referrals, or bot traffic can remove rewards.</p><p>Withdrawals are reviewed to protect real creators.</p></div>
      <Link href="/wallet"><button className="mt-4 w-full rounded-2xl border border-[#FF4D8D]/35 bg-[#FF4D8D]/10 py-3 font-black text-[#FF8FA3]"><DollarSign size={14} className="mr-2 inline" />Withdraw Creator Rewards</button></Link>
    </section>
  </div>;
}

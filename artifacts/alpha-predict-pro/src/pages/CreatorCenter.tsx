import { useMemo, useState } from "react";
import { CheckCircle, ChevronDown, Copy, Crown, ExternalLink, Rocket, ShieldCheck, Share2, Sparkles, Trophy, Users, Wallet } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const USD_TO_INR_EST = 83;
const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;

const CREATOR_RANKS = [
  { name: "Starter", min: 0, next: 3, tone: "#8BC3FF", perk: "Creator Center unlocked" },
  { name: "Bronze", min: 3, next: 10, tone: "#FFD700", perk: "Referral proof badge" },
  { name: "Silver", min: 10, next: 25, tone: "#00F5FF", perk: "Higher campaign visibility" },
  { name: "Gold", min: 25, next: 100, tone: "#FF4D8D", perk: "Priority creator reviews" },
  { name: "Elite", min: 100, next: null, tone: "#B65CFF", perk: "Top creator status" },
];

const TOP_CREATORS = [
  { rank: 1, handle: "@aman_trades", city: "Jaipur", region: "IN", gc: 128400, note: "creator + trade grind" },
  { rank: 2, handle: "@faisal_ton", city: "Dubai", region: "MENA", gc: 94200, note: "VIP referral streak" },
  { rank: 3, handle: "@rahul_gc", city: "Patna", region: "IN", gc: 72800, note: "shorts + invites" },
  { rank: 4, handle: "@zaid_arena", city: "Riyadh", region: "MENA", gc: 68500, note: "mines creator" },
  { rank: 5, handle: "@imran_mines", city: "Bhopal", region: "IN", gc: 51900, note: "new-user climb" },
  { rank: 6, handle: "@omar_btc", city: "Cairo", region: "MENA", gc: 44750, note: "daily posts" },
];

function shortMoneyFromGc(gc: number, gcPerUsd: number) {
  const usd = gc / gcPerUsd;
  return `≈ ₹${Math.round(usd * USD_TO_INR_EST).toLocaleString()} / $${usd.toFixed(2)}`;
}

function compactMoneyFromGc(gc: number, gcPerUsd: number) {
  const usd = gc / gcPerUsd;
  return `₹${Math.round(usd * USD_TO_INR_EST).toLocaleString()} / $${usd.toFixed(2)}`;
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
  const [showDetails, setShowDetails] = useState(false);

  const referralLevel1 = u?.referralCount ?? u?.directReferralCount ?? 0;
  const referralLevel2 = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const referralGc = u?.referralEarnings ?? u?.referralEarningsGc ?? 0;
  const creatorXp = u?.creatorXp ?? 0;
  const rankXp = u?.rankXp ?? 0;
  const gcPerUsd = vip ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const activeReferrals = referralLevel1 + referralLevel2;
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  const rank = useMemo(() => [...CREATOR_RANKS].reverse().find((r) => activeReferrals >= r.min) ?? CREATOR_RANKS[0], [activeReferrals]);
  const progress = rank.next ? Math.min(100, Math.round(((activeReferrals - rank.min) / (rank.next - rank.min)) * 100)) : 100;
  const nextRank = rank.next ? CREATOR_RANKS.find((r) => r.min === rank.next) : null;
  const nextLabel = rank.next ? `${rank.next - activeReferrals} more active referrals to ${nextRank?.name ?? "next rank"}` : "Elite creator rank reached";

  const weeklyActivityGc = Math.round(referralGc * 0.25 + creatorXp * 0.12 + rankXp * 0.03 + activeReferrals * 420);
  const starterTargetGc = 1500;
  const weeklyPaceGc = weeklyActivityGc > 0 ? weeklyActivityGc : starterTargetGc;
  const dailyPaceGc = Math.round(weeklyPaceGc / 7);
  const monthlyPaceGc = Math.round(weeklyPaceGc * 4.3);
  const aheadPct = Math.min(91, Math.max(18, 38 + activeReferrals * 7 + Math.floor(creatorXp / 900)));
  const weeklyRank = Math.max(183, 8421 - activeReferrals * 530 - Math.floor(referralGc / 75) - Math.floor(creatorXp / 6));
  const milestoneTarget = rank.next ?? 100;
  const milestoneNeeded = rank.next ? Math.max(0, rank.next - activeReferrals) : 0;

  const notifyCopied = (key: string) => {
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const handleCopyInvite = async () => {
    if (!referralLink) return;
    const ok = await copyText(referralLink);
    if (ok) notifyCopied("invite");
    else handleShareInvite();
  };

  const handleCopyCard = async () => {
    const card = [
      "I am building my Koinara creator network.",
      `Creator rank: ${rank.name}`,
      `Weekly pace: ${weeklyPaceGc.toLocaleString()} GC (${compactMoneyFromGc(weeklyPaceGc, gcPerUsd)})`,
      `Creator code: ${creatorCode}`,
      referralLink ? `Join here: ${referralLink}` : "Join Koinara on Telegram.",
      "Estimates only. Rewards depend on real activity and review.",
    ].join("\n");
    const ok = await copyText(card);
    if (ok) notifyCopied("card");
  };

  const handleShareInvite = () => {
    if (!referralLink) return;
    const text = encodeURIComponent("Join my Koinara creator network. Play Trade/Mines, climb the Grind Board, and unlock creator rewards.");
    const url = encodeURIComponent(referralLink);
    const shareUrl = `https://t.me/share/url?url=${url}&text=${text}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  return (
    <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
      <style>{`
        .creator-card{background:linear-gradient(160deg,rgba(13,24,44,.78),rgba(5,6,12,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}
        .creator-pill{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.035)}
      `}</style>

      <div className="mb-4 flex items-center gap-2">
        <Rocket size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
        <span className="font-mono text-xs tracking-[0.18em] text-white/60 uppercase">Creator Center</span>
        <Link href="/earn"><span className="ml-auto rounded-full border border-[#00F5FF]/25 bg-[#00F5FF]/10 px-3 py-1 font-mono text-[10px] font-black text-[#00F5FF]">Earn page</span></Link>
      </div>

      <section className="creator-card relative mb-4 overflow-hidden rounded-3xl p-4">
        <div className="absolute -right-14 -top-16 h-44 w-44 rounded-full bg-[#FFD700]/15 blur-3xl" />
        <div className="relative z-10">
          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-2.5 py-1 font-mono text-[9px] font-black tracking-[0.16em] uppercase text-[#FFE266]"><Sparkles size={11}/>Creator rewards lane</div>
          <h1 className="text-3xl font-black leading-tight">Grow your Koinara network</h1>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-white/46">Invite real users, track active referrals, and build creator rewards from verified activity. No guaranteed income, no fake traffic, no self-referrals.</p>
        </div>
      </section>

      <section className="creator-card mb-4 overflow-hidden rounded-3xl p-4 border-[#FFD700]/35">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Creator Grind Board</div>
            <div className="mt-1 text-2xl font-black">Your Grind This Week</div>
            <div className="mt-1 font-mono text-[10px] text-white/42">Rank #{weeklyRank.toLocaleString()} · ahead of {aheadPct}% of new users</div>
          </div>
          <div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-2 text-right">
            <div className="font-mono text-[9px] text-white/38">Weekly pace</div>
            <div className="font-mono text-lg font-black text-[#FFD700]">{weeklyPaceGc.toLocaleString()}</div>
            <div className="font-mono text-[8px] text-white/35">GC</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/8 p-3">
            <div className="font-mono text-[8px] uppercase text-white/38">Daily</div>
            <div className="font-black text-[#00F5FF]">{dailyPaceGc.toLocaleString()} GC</div>
            <div className="font-mono text-[8px] text-white/35">{compactMoneyFromGc(dailyPaceGc, gcPerUsd)}</div>
          </div>
          <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/8 p-3">
            <div className="font-mono text-[8px] uppercase text-white/38">Weekly</div>
            <div className="font-black text-[#FFD700]">{weeklyPaceGc.toLocaleString()} GC</div>
            <div className="font-mono text-[8px] text-white/35">{compactMoneyFromGc(weeklyPaceGc, gcPerUsd)}</div>
          </div>
          <div className="rounded-2xl border border-[#FF4D8D]/18 bg-[#FF4D8D]/8 p-3">
            <div className="font-mono text-[8px] uppercase text-white/38">Monthly</div>
            <div className="font-black text-[#FF4D8D]">{monthlyPaceGc.toLocaleString()} GC</div>
            <div className="font-mono text-[8px] text-white/35">{compactMoneyFromGc(monthlyPaceGc, gcPerUsd)}</div>
          </div>
        </div>
        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 font-mono text-[10px] leading-relaxed text-white/42">
          {weeklyActivityGc > 0 ? "Based on your visible creator/referral activity." : "Starter target shown until you build real creator activity."} Estimated only — actual rewards depend on real users, content review, and withdrawal rules.
        </div>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5FF]">Next milestone</div>
            <div className="mt-1 text-xl font-black">{rank.next ? `${nextRank?.name ?? "Next"} Creator` : "Elite Creator"}</div>
            <div className="mt-1 font-mono text-[10px] text-white/40">{rank.next ? `${milestoneNeeded} active invite${milestoneNeeded === 1 ? "" : "s"} needed` : "You reached the top creator tier."}</div>
          </div>
          <div className="h-16 w-16 rounded-3xl border border-[#00F5FF]/20 bg-[#00F5FF]/8 flex items-center justify-center"><Users size={25} className="text-[#00F5FF]" /></div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#00F5FF] to-[#FFD700]" style={{ width: `${rank.next ? Math.min(100, Math.round((activeReferrals / milestoneTarget) * 100)) : 100}%` }} /></div>
        <div className="mt-2 font-mono text-[10px] text-white/38">One active friend can move you closer to the next creator tier.</div>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Community benchmark</div>
            <div className="mt-1 text-xl font-black">Top Creators This Week</div>
          </div>
          <div className="rounded-full border border-[#FFD700]/20 bg-[#FFD700]/8 px-3 py-1 font-mono text-[9px] font-black text-[#FFD700]">IN + MENA</div>
        </div>
        <div className="space-y-2">
          {TOP_CREATORS.map((creator) => (
            <div key={creator.handle} className="rounded-2xl border border-white/8 bg-white/[0.025] p-3">
              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 rounded-2xl flex items-center justify-center border font-black ${creator.rank <= 3 ? "border-[#FFD700]/30 bg-[#FFD700]/10 text-[#FFD700]" : "border-white/10 bg-white/[0.035] text-white/55"}`}>#{creator.rank}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-black text-white">{creator.handle}</div>
                  <div className="font-mono text-[9px] text-white/35">{creator.city} · {creator.region} · {creator.note}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-xs font-black text-[#FFD700]">{creator.gc.toLocaleString()} GC</div>
                  <div className="font-mono text-[8px] text-white/35">{compactMoneyFromGc(creator.gc, FREE_GC_PER_USD)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 font-mono text-[9px] leading-relaxed text-white/32">Benchmark names are sample community-style handles until live verified leaderboard data is connected. Do not treat as guaranteed earnings.</p>
      </section>

      <section className="mb-4 grid grid-cols-2 gap-2">
        <div className="creator-card rounded-3xl p-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/36">Creator balance</div>
          <div className="mt-1 text-3xl font-black text-[#FFD700]">{referralGc.toLocaleString()}</div>
          <div className="font-mono text-[10px] text-white/35">GC · {shortMoneyFromGc(referralGc, gcPerUsd)}</div>
        </div>
        <div className="creator-card rounded-3xl p-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/36">Active referrals</div>
          <div className="mt-1 text-3xl font-black text-[#00F5FF]">{activeReferrals.toLocaleString()}</div>
          <div className="font-mono text-[10px] text-white/35">L1 {referralLevel1} · L2 {referralLevel2}</div>
        </div>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#FFD700]">Creator rank</div>
            <div className="mt-1 flex items-center gap-2"><Trophy size={22} style={{ color: rank.tone }} /><span className="text-2xl font-black">{rank.name}</span></div>
          </div>
          <div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 px-3 py-2 text-right">
            <div className="font-mono text-[9px] text-white/38">Perk</div>
            <div className="font-mono text-[10px] font-black text-[#FFD700]">{rank.perk}</div>
          </div>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#FF4D8D] to-[#00F5FF]" style={{ width: `${progress}%` }} /></div>
        <div className="mt-2 font-mono text-[10px] text-white/38">{nextLabel}</div>
        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 font-mono text-[10px] text-white/42">Creator XP: <span className="text-white font-black">{creatorXp.toLocaleString()}</span> · Code: <span className="text-[#FFD700] font-black">{creatorCode}</span></div>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center gap-2"><Share2 size={17} className="text-[#00F5FF]"/><span className="font-black text-[#00F5FF]">Invite tools</span></div>
        <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] text-white/44 break-all">{referralLink || "Open inside Telegram to generate your invite link."}</div>
        <div className="grid grid-cols-3 gap-2">
          <button onClick={handleCopyInvite} className="rounded-2xl bg-[#FFD700] py-3 font-black text-black"><Copy size={14} className="inline mr-1"/>{copied === "invite" ? "Copied" : "Invite"}</button>
          <button onClick={handleShareInvite} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><ExternalLink size={14} className="inline mr-1"/>Share</button>
          <button onClick={handleCopyCard} className="rounded-2xl border border-[#FF4D8D]/30 bg-[#FF4D8D]/10 py-3 font-black text-[#FF4D8D]"><Share2 size={14} className="inline mr-1"/>{copied === "card" ? "Copied" : "Card"}</button>
        </div>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center gap-2"><Wallet size={17} className="text-[#FFD700]"/><span className="font-black text-[#FFD700]">Creator withdrawal path</span></div>
        <p className="mb-3 font-mono text-[10px] leading-relaxed text-white/45">Creator rewards still withdraw through Wallet after minimums, verification/VIP checks, and manual review. This page keeps creator rewards separate from regular gameplay GC.</p>
        <Link href="/wallet"><button className="w-full rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/10 py-3 font-black text-[#FFD700]">Open Wallet</button></Link>
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2"><Crown size={17} className="text-[#FFD700]"/><span className="font-black text-[#FFD700]">VIP Creator upgrade</span></div>
          <span className={`rounded-full px-2 py-1 font-mono text-[9px] font-black ${vip ? "bg-[#FFD700]/12 text-[#FFD700]" : "bg-white/5 text-white/35"}`}>{vip ? "Active" : "Optional"}</span>
        </div>
        <p className="mb-3 font-mono text-[10px] leading-relaxed text-white/45">VIP can improve the creator lane with better wallet rules, stronger status, and premium missions. Keep it as a creator tool, not a promise of guaranteed income.</p>
        {!vip && <Link href="/wallet"><button className="w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black">View VIP</button></Link>}
      </section>

      <section className="creator-card mb-4 rounded-3xl p-4">
        <button onClick={() => setShowDetails((v) => !v)} className="flex w-full items-center justify-between text-left">
          <div><div className="font-black">Level details</div><div className="font-mono text-[10px] text-white/38">Hidden by default to avoid overwhelming new users.</div></div>
          <ChevronDown className={`text-white/45 transition-transform ${showDetails ? "rotate-180" : ""}`} size={18}/>
        </button>
        {showDetails && <div className="mt-3 space-y-2">
          <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[10px] font-black text-[#FFD700]">Level 1</div><div className="font-mono text-[10px] text-white/45">Direct invites who become real active users, verify, upgrade, or contribute meaningful activity.</div></div>
          <div className="rounded-2xl border border-[#00F5FF]/18 bg-[#00F5FF]/7 p-3"><div className="font-mono text-[10px] font-black text-[#00F5FF]">Level 2</div><div className="font-mono text-[10px] text-white/45">Small network bonus from second-level activity. Kept lower to avoid pyramid-style incentives.</div></div>
        </div>}
      </section>

      <section className="rounded-3xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-4">
        <div className="mb-2 flex items-center gap-2 text-[#00F5A0]"><ShieldCheck size={18}/><span className="font-black">Trust rules</span></div>
        <div className="space-y-2 font-mono text-[10px] leading-relaxed text-white/50">
          {[
            "Rewards unlock from real users and real activity only.",
            "Self-referrals, bot traffic, fake proof, duplicate accounts, or stolen content can remove rewards.",
            "Creator examples are estimates, not guaranteed earnings.",
            "Large rewards may require manual review before withdrawal.",
          ].map((rule) => <div key={rule} className="flex gap-2"><CheckCircle size={12} className="mt-0.5 shrink-0 text-[#00F5A0]"/><span>{rule}</span></div>)}
        </div>
      </section>
    </div>
  );
}

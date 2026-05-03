import { useEffect, useMemo, useState } from "react";
import { beginCell } from "@ton/core";
import { useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { CheckCircle, Copy, Crown, Gift, Loader2, MessageCircle, Rocket, Share2, Sparkles, Target, TrendingUp, Users, Video, Wallet } from "lucide-react";
import { Link } from "wouter";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
type Mission = { title: string; detail: string; done: boolean; cta: string; href?: string; onClick?: () => void };

const CR_PER_USD = 1000;
const AED_PER_USD = 3.67;
const CREATOR_PASS_TON_AMOUNT = "200000000";
const CREATOR_PASS_USD = 0.99;
const VIP_MONTHLY_USD = 5.99;
const OPERATOR_TON_WALLET: string | undefined = import.meta.env.VITE_KOINARA_TON_WALLET || import.meta.env.VITE_TON_WALLET || undefined;

const CONTENT_REWARD_RANGES = [
  { label: "Instagram Reel", range: "100-300 CR" },
  { label: "TikTok video", range: "100-300 CR" },
  { label: "YouTube Short", range: "150-400 CR" },
  { label: "YouTube long video", range: "300-800 CR" },
  { label: "X post", range: "75-200 CR" },
  { label: "Telegram channel post", range: "100-250 CR" },
];

function apiBase() { return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""; }
function authHeaders(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData;
  return initData ? { "x-telegram-init-data": initData } : {};
}
function jsonAuthHeaders(): HeadersInit { return { "Content-Type": "application/json", ...authHeaders() }; }
function crUsd(cr: number) { return `$${(cr / CR_PER_USD).toFixed(2)}`; }
function crAed(cr: number) { return `AED ${((cr / CR_PER_USD) * AED_PER_USD).toFixed(2)}`; }
function usdToCr(usd: number) { return Math.floor(usd * CR_PER_USD); }
function usdToAed(usd: number) { return `AED ${(usd * AED_PER_USD).toFixed(2)}`; }
function name(row: Leader) { return row.username ? `@${row.username}` : row.firstName || `Creator ${row.telegramId.slice(-4)}`; }
function creatorMemo(telegramId: string) { return `KNR-CREATOR-PASS-${telegramId}`; }
function memoPayload(memo: string): string { return beginCell().storeUint(0, 32).storeStringTail(memo).endCell().toBoc().toString("base64"); }
async function copyText(text: string) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }

function creatorRank(activeRefs: number) {
  if (activeRefs >= 500) return { title: "Diamond Creator", next: "Partner review", progress: 100, need: 0 };
  if (activeRefs >= 100) return { title: "Gold Creator", next: "Diamond Creator", progress: Math.min(100, Math.round(((activeRefs - 100) / 400) * 100)), need: 500 - activeRefs };
  if (activeRefs >= 25) return { title: "Silver Creator", next: "Gold Creator", progress: Math.min(100, Math.round(((activeRefs - 25) / 75) * 100)), need: 100 - activeRefs };
  return { title: "Bronze Creator", next: "Silver Creator", progress: Math.min(100, Math.round((activeRefs / 25) * 100)), need: 25 - activeRefs };
}

export default function CreatorCenter() {
  const { user, refreshUser } = useTelegram();
  const vip = isVipActive(user);
  const u = user as any;
  const qc = useQueryClient();
  const walletAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const creatorActive = vip || !!u?.creatorPassPaid || !!summary?.creatorPassPaid;
  const cr = summary?.creatorCredits ?? u?.creatorCredits ?? 0;
  const pendingCr = summary?.pendingCr ?? 0;
  const withdrawableCr = summary?.withdrawableCr ?? 0;
  const directRefs = summary?.directReferralCount ?? u?.directReferralCount ?? u?.referralCount ?? 0;
  const level2Refs = summary?.level2ReferralCount ?? u?.level2ReferralCount ?? 0;
  const activeNetwork = directRefs + level2Refs;
  const rank = useMemo(() => creatorRank(activeNetwork), [activeNetwork]);
  const referralLink = user ? `https://t.me/KoinaraBot?start=${user.telegramId}` : "";
  const creatorCode = user?.telegramId ? `KNR-${String(user.telegramId).slice(-6)}` : "KNR-YOURCODE";

  const loadCreatorData = async () => {
    if (!user?.telegramId) return;
    try {
      const s = await fetch(`${apiBase()}/api/creator/${user.telegramId}/cr-summary`, { headers: authHeaders() });
      if (s.ok) setSummary(await s.json());
      const l = await fetch(`${apiBase()}/api/creator/leaderboard`, { headers: authHeaders() });
      if (l.ok) {
        const data = await l.json();
        setLeaders(Array.isArray(data?.rows) ? data.rows : []);
      }
    } catch {}
  };

  useEffect(() => { loadCreatorData(); }, [user?.telegramId]);

  const copyLink = async () => {
    const ok = referralLink ? await copyText(referralLink) : false;
    setNotice(ok ? "Creator link copied." : "Copy failed. Use Telegram or WhatsApp share.");
    window.setTimeout(() => setNotice(null), 1600);
  };

  const shareMessage = () => `🚀 Join me on Koinara!\n\nBuild your creator network, play Mines, and earn Creator Rewards from verified activity.\nCreator Pass costs only $0.99 (${usdToAed(CREATOR_PASS_USD)}).\n\nJoin here: ${referralLink}\n\nEarnings are performance-based and not guaranteed. Based on verified referral activity.`;

  const shareTelegram = () => {
    if (!referralLink) return;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareMessage())}`;
    window.Telegram?.WebApp?.openTelegramLink?.(shareUrl) ?? window.open(shareUrl, "_blank");
  };

  const shareWhatsApp = () => {
    if (!referralLink) return;
    window.open(`whatsapp://send?text=${encodeURIComponent(shareMessage())}`, "_blank");
  };

  const buyCreatorPassTon = async () => {
    if (!user?.telegramId || paying || creatorActive) return;
    if (!OPERATOR_TON_WALLET) { setNotice("TON payments are not configured yet. Please contact support."); return; }
    try {
      setPaying(true);
      setNotice(null);
      if (!walletAddress) {
        await tonConnectUI.openModal();
        setNotice("Connect your TON wallet, then tap Pay 0.2 TON again.");
        return;
      }
      const memo = creatorMemo(user.telegramId);
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: OPERATOR_TON_WALLET, amount: CREATOR_PASS_TON_AMOUNT, payload: memoPayload(memo) }] });
      setNotice("Payment sent. Verifying Creator Pass on-chain...");
      await new Promise((r) => setTimeout(r, 5000));
      const res = await fetch(`${apiBase()}/api/creator/purchase-pass`, { method: "POST", headers: jsonAuthHeaders(), body: JSON.stringify({ telegramId: user.telegramId, paymentMethod: "ton", senderAddress: walletAddress, grossUsd: CREATOR_PASS_USD }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Creator Pass verification failed.");
      setNotice("Creator Pass active. CR commissions are now enabled.");
      await refreshUser();
      qc.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await loadCreatorData();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Creator Pass payment failed or was cancelled.");
    } finally {
      setPaying(false);
    }
  };

  const vipOne = usdToCr(VIP_MONTHLY_USD * 0.2);
  const vipFive = vipOne * 5;
  const vipTen = vipOne * 10;
  const missionXp = Math.min(100, 20 + Math.min(activeNetwork, 25) * 3 + (creatorActive ? 25 : 0) + (cr > 0 ? 15 : 0));
  const missions: Mission[] = [
    { title: "Open Creator Dashboard", detail: "Check your rank, CR, and Creator League progress.", done: true, cta: "Done" },
    { title: "Share your creator link", detail: "Send your link on WhatsApp or Telegram today.", done: false, cta: "Share", onClick: shareWhatsApp },
    { title: "Play 1 Mines round", detail: "Use Play TC for daily Arcade activity.", done: false, cta: "Play", href: "/mines" },
    { title: "Invite 1 active user", detail: `${directRefs} direct referrals tracked so far.`, done: directRefs > 0, cta: directRefs > 0 ? "Tracked" : "Invite", onClick: shareTelegram },
    { title: "Submit Koinara content", detail: "Post a Reel, Short, X post, or Telegram post for review.", done: (summary?.contentRewardCr ?? 0) > 0, cta: "View", href: "#content-rewards" },
  ];
  const completedMissions = missions.filter((mission) => mission.done).length;
  const chestReady = completedMissions >= 3;

  return <div className="min-h-screen bg-black px-4 pb-28 pt-4 text-white">
    <style>{`.creator-card{background:linear-gradient(160deg,rgba(13,24,44,.78),rgba(5,6,12,.96));border:1px solid rgba(0,245,160,.2);box-shadow:0 18px 55px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.05)}.creator-gold{background:linear-gradient(135deg,#FFF7D1,#FFD700,#00F5A0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`}</style>
    <div className="mb-4 flex items-center gap-2"><Rocket size={16} className="text-[#00F5A0]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Creator Network</span></div>
    {notice && <div className="mb-4 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-[#00F5A0]">{notice}</div>}

    <section className="creator-card mb-4 rounded-3xl p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Koinara Creator</div>
      <h1 className="creator-gold mt-1 text-4xl font-black leading-none">Build Your Network</h1>
      <p className="mt-3 font-mono text-[11px] leading-relaxed text-white/52">Invite users with your creator link. Earn CR from qualified purchases, VIP renewals, and approved content after review.</p>
      <div className="mt-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-[#FFD700]">Hindi: Apna link share karo, users lao, aur qualified sales se Creator Credits kamao. Earnings guaranteed nahi hain — performance aur review par depend karta hai.</div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-2xl border border-[#00F5A0]/15 bg-[#00F5A0]/7 p-2"><div className="font-mono text-[8px] text-white/35">CR rate</div><div className="font-black text-[#00F5A0]">1K = $1</div></div><div className="rounded-2xl border border-[#00F5FF]/15 bg-[#00F5FF]/7 p-2"><div className="font-mono text-[8px] text-white/35">Dirham</div><div className="font-black text-[#00F5FF]">1K ≈ AED 3.67</div></div><div className="rounded-2xl border border-[#FFD700]/15 bg-[#FFD700]/7 p-2"><div className="font-mono text-[8px] text-white/35">Review</div><div className="font-black text-[#FFD700]">48h</div></div></div>
    </section>

    <section className="creator-card mb-4 rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Sparkles size={16} className="text-[#FFD700]"/><div className="font-black text-xl">Creator League</div><span className="ml-auto rounded-full border border-[#FFD700]/20 bg-[#FFD700]/8 px-2 py-1 font-mono text-[8px] text-[#FFD700]">Season 1</span></div>
      <div className="grid grid-cols-[1fr_auto] gap-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-3"><div><div className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">Today’s progress</div><div className="mt-1 text-2xl font-black text-[#FFD700]">{completedMissions}/5 missions</div><p className="mt-1 font-mono text-[10px] text-white/40">Complete 3 missions to unlock your daily Creator Chest.</p></div><div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-[#FFD700]/30 bg-[#FFD700]/10"><Gift size={30} className={chestReady ? "text-[#FFD700]" : "text-white/35"}/></div></div>
      <div className="mt-3"><div className="mb-1 flex items-center justify-between font-mono text-[9px] text-white/35"><span>Creator XP</span><span>{missionXp}%</span></div><div className="h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#00F5A0] to-[#FFD700]" style={{ width: `${missionXp}%` }} /></div></div>
      <div className="mt-3 space-y-2">{missions.map((mission) => <div key={mission.title} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className={`flex h-8 w-8 items-center justify-center rounded-xl border ${mission.done ? "border-[#00F5A0]/30 bg-[#00F5A0]/10 text-[#00F5A0]" : "border-[#FFD700]/25 bg-[#FFD700]/10 text-[#FFD700]"}`}>{mission.done ? <CheckCircle size={15}/> : <Target size={14}/>}</div><div className="min-w-0 flex-1"><div className="font-black text-sm">{mission.title}</div><div className="font-mono text-[9px] leading-relaxed text-white/38">{mission.detail}</div></div>{mission.href ? <Link href={mission.href}><button className="rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[9px] font-black text-[#FFD700]">{mission.cta}</button></Link> : <button onClick={mission.onClick} disabled={mission.done && !mission.onClick} className="rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[9px] font-black text-[#FFD700] disabled:opacity-40">{mission.cta}</button>}</div>)}</div>
      <div className={`mt-3 rounded-2xl border p-3 font-mono text-[10px] leading-relaxed ${chestReady ? "border-[#00F5A0]/25 bg-[#00F5A0]/8 text-[#00F5A0]" : "border-white/10 bg-white/[0.025] text-white/42"}`}>{chestReady ? "Creator Chest ready soon: rewards will be Play TC, XP, badges, and boost tickets. CR will only come from verified purchases or approved content." : "Creator Chest is a safe daily loop. It does not auto-pay CR; it builds activity, status, and retention."}</div>
    </section>

    {!creatorActive && <section className="creator-card mb-4 rounded-3xl p-4"><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Activate Creator Tools</div><div className="mt-1 text-3xl font-black">Creator Pass</div><div className="mt-1 font-mono text-sm text-[#FFD700]">$0.99 · {usdToAed(CREATOR_PASS_USD)} · 0.2 TON</div><p className="mt-2 font-mono text-[11px] text-white/48">Unlocks creator link, Level 1 / Level 2 dashboard, CR tracking, leaderboard, and content rewards.</p><div className="mt-3 rounded-2xl border border-[#00F5A0]/20 bg-[#00F5A0]/8 p-3 font-mono text-[10px] leading-relaxed text-white/55">Stars checkout is disabled for safety. TON checkout verifies on-chain before activation.</div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => setNotice("Stars checkout is not enabled yet. Use TON for Creator Pass.")} className="rounded-2xl border border-white/10 bg-white/[0.04] py-3 font-black text-white/35">Stars soon</button><button onClick={buyCreatorPassTon} disabled={paying} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF] disabled:opacity-45">{paying ? <><Loader2 size={14} className="inline mr-2 animate-spin"/>Verifying</> : "Pay 0.2 TON"}</button></div><p className="mt-3 font-mono text-[9px] text-white/35">Required memo: {user?.telegramId ? creatorMemo(user.telegramId) : "shown after login"}</p></section>}

    {creatorActive && <>
      <section className="creator-card mb-4 rounded-3xl p-4"><div className="flex items-center justify-between gap-3"><div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Your Rank</div><div className="mt-1 text-2xl font-black text-[#00F5A0]">{rank.title}</div><p className="mt-1 font-mono text-[10px] text-white/40">Next: {rank.next}{rank.need > 0 ? ` · ${rank.need} more network users` : ""}</p></div><div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3"><Crown size={28} className="text-[#FFD700]"/></div></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#00F5A0] to-[#FFD700]" style={{ width: `${rank.progress}%` }} /></div><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Level 1 direct</div><div className="text-2xl font-black">{directRefs}</div></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Level 2 network</div><div className="text-2xl font-black">{level2Refs}</div></div></div></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#00F5A0]">Creator Earnings</div><div className="mt-1 text-4xl font-black text-[#00F5A0]">{cr.toLocaleString()} CR</div><div className="mt-1 font-mono text-xs text-white/50">≈ {crUsd(cr)} · {crAed(cr)}</div><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#00F5A0]/15 bg-[#00F5A0]/7 p-3"><div className="font-mono text-[9px] text-white/38">Withdrawable</div><div className="text-xl font-black text-[#00F5A0]">{withdrawableCr.toLocaleString()} CR</div><div className="font-mono text-[8px] text-white/35">{crUsd(withdrawableCr)} · {crAed(withdrawableCr)}</div></div><div className="rounded-2xl border border-[#FFD700]/15 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/38">Pending review</div><div className="text-xl font-black text-[#FFD700]">{pendingCr.toLocaleString()} CR</div><div className="font-mono text-[8px] text-white/35">48 hour review</div></div></div><Link href="/wallet"><button className="mt-3 w-full rounded-2xl bg-[#00F5A0] py-3 font-black text-black"><Wallet size={14} className="inline mr-2"/>Withdraw CR</button></Link><p className="mt-2 font-mono text-[9px] text-white/35">Min 1,000 CR · 10% fee · no daily cap. CR is separate from GC and TC.</p></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Share2 size={16} className="text-[#00F5A0]"/><div className="font-black text-xl">Your Creator Link</div></div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 font-mono text-[10px] break-all text-white/50">{referralLink}</div><div className="mb-3 rounded-2xl border border-[#00F5A0]/20 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-[#00F5A0]">Creator code: <b>{creatorCode}</b></div><div className="grid grid-cols-3 gap-2"><button onClick={copyLink} className="rounded-2xl bg-[#00F5A0] py-3 font-black text-black"><Copy size={14} className="inline mr-1"/>Copy</button><button onClick={shareTelegram} className="rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]"><Share2 size={14} className="inline mr-1"/>Telegram</button><button onClick={shareWhatsApp} className="rounded-2xl border border-[#25D366]/30 bg-[#25D366]/10 py-3 font-black text-[#25D366]"><MessageCircle size={14} className="inline mr-1"/>WhatsApp</button></div></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><TrendingUp size={16} className="text-[#FFD700]"/><div className="font-black text-xl">VIP Earnings Preview</div></div><div className="space-y-2">{[{ label: "1 friend buys VIP", cr: vipOne }, { label: "5 friends buy VIP", cr: vipFive }, { label: "10 friends buy VIP", cr: vipTen }].map((row) => <div key={row.label} className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="flex items-center justify-between"><div><div className="font-black">{row.label}</div><div className="font-mono text-[9px] text-white/35">VIP: ${VIP_MONTHLY_USD.toFixed(2)}/month · L1 estimate</div></div><div className="text-right"><div className="font-mono text-[10px] text-[#00F5A0]">+{row.cr.toLocaleString()} CR</div><div className="font-mono text-[9px] text-white/35">{crUsd(row.cr)} · {crAed(row.cr)}</div></div></div></div>)}</div><p className="mt-3 font-mono text-[9px] leading-relaxed text-white/35">Estimates are based on verified referral purchases. Actual earnings depend on referral activity and platform review.</p></section>

      <section id="content-rewards" className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Video size={16} className="text-[#FFD700]"/><div className="font-black text-xl">Content Rewards</div><span className="ml-auto rounded-full border border-[#FFD700]/20 bg-[#FFD700]/8 px-2 py-1 font-mono text-[8px] text-[#FFD700]">Coming soon</span></div><p className="font-mono text-[10px] leading-relaxed text-white/50">Submit Koinara content for review. Approved posts may earn Creator Credits based on quality, reach, and anti-abuse checks.</p><div className="mt-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] leading-relaxed text-[#FFD700]">Hindi: Koinara content post karo aur submit karo. Approved content par Creator Credits mil sakte hain. Review ke baad hi reward milega — automatic nahi.</div><div className="mt-3 space-y-2">{CONTENT_REWARD_RANGES.map((item) => <div key={item.label} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[0.025] px-3 py-2"><div className="font-mono text-[10px] text-white/60">{item.label}</div><div className="font-mono text-[10px] font-black text-[#FFD700]">{item.range}</div></div>)}</div><p className="mt-3 font-mono text-[9px] leading-relaxed text-white/35">Rewards are not automatic. Fake views, spam, duplicate submissions, or low-quality posts can be rejected. Backend submission form stays disabled until the review endpoint is ready.</p></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Users size={16} className="text-[#00F5A0]"/><div className="font-black text-xl">Network Stats</div></div>{activeNetwork === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">Your first referral will appear here. Share your link to get started.</div> : <div className="grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Direct referrals</div><div className="text-2xl font-black">{directRefs}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Level 2 referrals</div><div className="text-2xl font-black">{level2Refs}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">VIP referrals</div><div className="text-2xl font-black">{summary?.vipReferralCount ?? 0}</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Network purchases</div><div className="text-2xl font-black">{summary?.networkPurchaseCount ?? 0}</div></div></div>}</section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Breakdown</div><div className="grid grid-cols-2 gap-2">{[["Level 1 CR", summary?.directCommissionCr ?? 0], ["Level 2 CR", summary?.networkCommissionCr ?? 0], ["Renewals", summary?.renewalCommissionCr ?? 0], ["Content", summary?.contentRewardCr ?? 0]].map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-[#00F5A0]/15 bg-[#00F5A0]/7 p-3"><div className="font-mono text-[9px] text-white/38">{label}</div><div className="text-xl font-black text-[#00F5A0]">{Number(value).toLocaleString()} CR</div><div className="font-mono text-[8px] text-white/35">{Number(value) > 0 ? `${crUsd(Number(value))} · ${crAed(Number(value))}` : "—"}</div></div>)}</div></section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Top CR Earners</div>{leaders.length === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/38">No verified creator earners yet.</div> : <div className="space-y-2">{leaders.map((row) => <div key={row.telegramId} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="h-9 w-9 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/10 text-[#00F5A0] flex items-center justify-center font-black">#{row.rank}</div><div className="min-w-0 flex-1"><div className="truncate font-mono text-xs font-black text-white">{name(row)}</div><div className="font-mono text-[9px] text-white/35">Real CR leaderboard</div></div><div className="text-right"><div className="font-mono text-xs font-black text-[#00F5A0]">{(row.totalCrEarned ?? 0).toLocaleString()} CR</div><div className="font-mono text-[9px] text-white/35">{crUsd(row.totalCrEarned ?? 0)} · {crAed(row.totalCrEarned ?? 0)}</div></div></div>)}</div>}</section>

      <section className="creator-card mb-4 rounded-3xl p-4"><div className="mb-3 font-black text-xl">Rules</div>{["CR comes from reviewed creator activity.", "1,000 CR = $1.00 ≈ AED 3.67.", "Withdraw above 1,000 CR.", "10% withdrawal fee applies.", "Commissions approve after 48 hour review.", "Fake activity, self-referrals, duplicate accounts, or fake payments may be rejected."].map((rule) => <div key={rule} className="mb-2 flex gap-2 font-mono text-[10px] text-white/50"><CheckCircle size={12} className="mt-0.5 text-[#00F5A0]"/><span>{rule}</span></div>)}</section>
    </>}
  </div>;
}

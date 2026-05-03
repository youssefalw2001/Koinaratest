import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowDown, ArrowUp, CheckCircle, Crown, Loader2, ShieldCheck, Sparkles, Target, Wallet, XCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;
const FREE_STAKES = [100, 250, 500];
const VIP_STAKES = [100, 250, 500, 1000];
const MULTIPLIER = 1.9;

type Prediction = "over" | "under";
type DiceResult = {
  roll: number;
  prediction: Prediction;
  won: boolean;
  stake: number;
  payout: number;
  rawPayout: number;
  capReached: boolean;
  dailyCap: number;
  dailyGcEarned: number;
  tradeCredits: number;
  goldCoins: number;
};

function authHeaders(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData;
  return initData ? { "x-telegram-init-data": initData } : {};
}
function jsonHeaders(): HeadersInit { return { "Content-Type": "application/json", ...authHeaders() }; }

export default function Dice() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [stake, setStake] = useState(100);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DiceResult | null>(null);
  const allowedStakes = vip ? VIP_STAKES : FREE_STAKES;
  const balanceTc = user?.tradeCredits ?? 0;
  const lowTc = balanceTc < stake;
  const preview = useMemo(() => Math.floor(stake * MULTIPLIER), [stake]);

  const play = async (prediction: Prediction) => {
    if (!user?.telegramId || busy) return;
    if (!allowedStakes.includes(stake)) { setNotice("Choose a valid Dice stake."); return; }
    if (lowTc) { setNotice("Insufficient Play TC. Refill from Arcade."); return; }
    setBusy(true);
    setNotice(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/dice/play`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ telegramId: user.telegramId, prediction, stake }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Dice round failed.");
      setResult(data as DiceResult);
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.(data.won ? "success" : "error");
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Dice round failed.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="min-h-screen bg-[#05070d] px-4 pb-28 pt-4 text-white">
    <style>{`.dice-card{background:linear-gradient(160deg,rgba(17,18,28,.92),rgba(5,8,16,.97));border:1px solid rgba(255,215,0,.18);box-shadow:0 14px 40px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}.dice-title{background:linear-gradient(135deg,#FFF5C2,#FFD700,#B8860B);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`}</style>

    <section className="dice-card mb-3 rounded-3xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#FFD700]">Koinara Arcade</div>
          <h1 className="dice-title mt-1 text-4xl font-black leading-none">Dice</h1>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/45">Fast over/under rounds. Server rolls the dice. Uses Play TC, never CR.</p>
        </div>
        <div className="rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/10 px-3 py-2 text-right">
          <div className="font-mono text-[9px] text-white/35">Play TC</div>
          <div className="font-mono text-lg font-black text-[#8BC3FF]">{balanceTc.toLocaleString()}</div>
        </div>
      </div>
    </section>

    {notice && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] text-[#FFD700]">{notice}</div>}

    <section className="dice-card mb-3 rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Target size={18} className="text-[#FFD700]"/><h2 className="text-2xl font-black">Pick the roll</h2><span className="ml-auto rounded-full border border-[#00F5A0]/25 bg-[#00F5A0]/8 px-2 py-1 font-mono text-[9px] text-[#00F5A0]">1.9x</span></div>
      <div className="mb-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-3 font-mono text-[10px] leading-relaxed text-white/52"><ShieldCheck size={13} className="mr-1 inline text-[#FFD700]"/>Rolls are generated server-side. Edge rolls are entertainment outcomes. CR remains creator-only.</div>
      <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="mb-2 flex justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/38">Stake</span><span className="font-mono text-[10px] text-white/35">{vip ? "VIP unlocked" : "VIP unlocks 1K"}</span></div><div className="grid grid-cols-4 gap-2">{VIP_STAKES.map((value) => <button key={value} onClick={() => setStake(value)} disabled={!allowedStakes.includes(value)} className={`h-11 rounded-xl border font-mono text-xs font-black disabled:opacity-30 ${stake === value ? "border-[#FFD700]/45 bg-[#FFD700]/15 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value >= 1000 ? `${value / 1000}K` : value}{!allowedStakes.includes(value) ? <Crown size={9} className="ml-0.5 inline"/> : null}</button>)}</div></div>
      <div className="mb-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/35">If correct</div><div className="font-black text-[#FFD700]">+{preview.toLocaleString()} GC</div></div><div className="rounded-2xl border border-[#4DA3FF]/18 bg-[#4DA3FF]/7 p-3"><div className="font-mono text-[9px] text-white/35">Daily Dice cap</div><div className="font-black text-[#8BC3FF]">{vip ? "10,000" : "3,000"} GC</div></div></div>
      {lowTc && <div className="mb-3 rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3"><div className="font-mono text-[10px] text-[#FF8FA3]">You need more Play TC for this stake.</div><Link href="/exchange"><button className="mt-2 w-full rounded-xl bg-[#FFD700] py-2 font-mono text-[10px] font-black text-black">Open Arcade</button></Link></div>}
      <div className="grid grid-cols-2 gap-2"><button onClick={() => play("over")} disabled={busy || lowTc} className="h-20 rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 font-black text-[#00F5A0] disabled:opacity-50">{busy ? <Loader2 size={22} className="mx-auto mb-1 animate-spin"/> : <ArrowUp size={24} className="mx-auto mb-1"/>}ROLL OVER 50</button><button onClick={() => play("under")} disabled={busy || lowTc} className="h-20 rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 font-black text-[#FF8FA3] disabled:opacity-50">{busy ? <Loader2 size={22} className="mx-auto mb-1 animate-spin"/> : <ArrowDown size={24} className="mx-auto mb-1"/>}ROLL UNDER 50</button></div>
    </section>

    {result && <section className={`mb-3 rounded-3xl border p-4 ${result.won && !result.capReached ? "border-[#00F5A0]/35 bg-[#00F5A0]/10 text-[#00F5A0]" : result.capReached ? "border-[#FFD700]/35 bg-[#FFD700]/10 text-[#FFD700]" : "border-[#FF4D6D]/35 bg-[#FF4D6D]/10 text-[#FF8FA3]"}`}>
      <div className="flex items-center gap-2">{result.won ? <CheckCircle size={18}/> : <XCircle size={18}/>}<h2 className="text-xl font-black">{result.capReached ? "Daily cap reached" : result.won ? "Correct" : "Missed"}</h2><span className="ml-auto font-mono text-xs">Roll: {result.roll}</span></div>
      <div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">You picked</div><div className="font-black text-white">{result.prediction === "over" ? "Over 50" : "Under 50"}</div></div><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">Result</div><div className="font-black text-white">{result.won ? `+${result.payout.toLocaleString()} GC` : `-${result.stake.toLocaleString()} TC`}</div></div></div>
      <p className="mt-3 font-mono text-[10px] leading-relaxed text-white/48">{result.capReached ? "You picked correctly, but your daily Game GC cap is full. Come back tomorrow or upgrade to VIP Creator." : result.won ? "Game GC added to your balance. CR is still earned only from verified creator activity." : "Play TC deducted. Try again or complete Creator League missions."}</p>
      <button onClick={() => setResult(null)} className="mt-3 w-full rounded-2xl border border-white/10 bg-white/[0.04] py-2.5 font-mono text-xs font-black text-white/70">Play again</button>
    </section>}

    <section className="rounded-3xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/7 p-3 font-mono text-[10px] leading-relaxed text-white/45"><Sparkles size={13} className="mr-1 inline text-[#8BC3FF]"/>Dice is Arcade entertainment. Play TC cannot be withdrawn. Creator Rewards are separate and come from verified referrals or approved content.</section>
  </div>;
}

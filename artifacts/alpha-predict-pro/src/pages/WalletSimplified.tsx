import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, CheckCircle, History, Loader2, RefreshCw, Shield, Wallet } from "lucide-react";
import { getGetUserQueryKey, getGetWithdrawalsQueryKey, requestWithdrawal, useGetWithdrawals } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { PageError, PageLoader } from "@/components/PageStatus";

const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const FREE_MIN_GC = 14000;
const VIP_MIN_GC = 2500;
const GC_FEE_PCT = 0.06;
const CR_PER_USD = 1000;
const MIN_CR = 1000;
const CR_FEE_PCT = 0.10;
const USD_TO_INR_EST = 83;

type WithdrawalRow = { id?: number | string; status?: string; gcAmount?: number; amountGc?: number; netUsd?: number; txHash?: string };
type CrSummary = { creatorCredits?: number; pendingCr?: number; withdrawableCr?: number; totalCrEarned?: number; creatorPassPaid?: boolean };

function apiBase() { return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""; }
function initHeaders() { const initData = window.Telegram?.WebApp?.initData ?? ""; return initData ? { "x-telegram-init-data": initData } : {}; }
function inr(usd: number) { return `₹${Math.round(usd * USD_TO_INR_EST).toLocaleString()}`; }
function usdGc(gc: number, rate: number) { return gc / rate; }
function usdCr(cr: number) { return cr / CR_PER_USD; }
function idem(prefix: string, parts: Array<string | number>) { return `${prefix}:${parts.join(":")}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`; }
function statusTone(status = "pending") {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: "Pending", color: "#FFD700", bg: "rgba(255,215,0,.1)" },
    processing: { label: "Processing", color: "#4DA3FF", bg: "rgba(77,163,255,.1)" },
    complete: { label: "Complete", color: "#00F5A0", bg: "rgba(0,245,160,.1)" },
    failed: { label: "Failed", color: "#FF4D6D", bg: "rgba(255,77,109,.1)" },
  };
  return map[status] ?? map.pending;
}

export default function WalletSimplified() {
  const { user, refreshUser } = useTelegram();
  const qc = useQueryClient();
  const u = user as any;
  const vip = isVipActive(user);
  const goldCoins = user?.goldCoins ?? 0;
  const tradeCredits = user?.tradeCredits ?? 0;
  const gcRate = vip ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const gcMin = vip ? VIP_MIN_GC : FREE_MIN_GC;
  const [usdtWallet, setUsdtWallet] = useState("");
  const [gcInput, setGcInput] = useState("");
  const [crInput, setCrInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [gcSubmitting, setGcSubmitting] = useState(false);
  const [crSubmitting, setCrSubmitting] = useState(false);
  const [crSummary, setCrSummary] = useState<CrSummary | null>(null);

  const creatorPassPaid = vip || !!u?.creatorPassPaid || !!crSummary?.creatorPassPaid;
  const creatorCredits = crSummary?.creatorCredits ?? u?.creatorCredits ?? 0;
  const pendingCr = crSummary?.pendingCr ?? 0;
  const withdrawableCr = crSummary?.withdrawableCr ?? 0;
  const totalCrEarned = crSummary?.totalCrEarned ?? u?.totalCrEarned ?? 0;
  const gcAmount = parseInt(gcInput.replace(/[^0-9]/g, ""), 10) || 0;
  const crAmount = parseInt(crInput.replace(/[^0-9]/g, ""), 10) || 0;
  const gcGrossUsd = usdGc(gcAmount, gcRate);
  const gcNetUsd = gcGrossUsd * (1 - GC_FEE_PCT);
  const crNet = Math.floor(crAmount * (1 - CR_FEE_PCT));
  const crNetUsd = usdCr(crNet);
  const canGcWithdraw = !!user && gcAmount >= gcMin && gcAmount <= goldCoins && usdtWallet.length >= 10 && !gcSubmitting;
  const canCrWithdraw = !!user && creatorPassPaid && crAmount >= MIN_CR && crAmount <= withdrawableCr && usdtWallet.length >= 10 && !crSubmitting;

  const { data: history, isLoading, isError, refetch } = useGetWithdrawals(user?.telegramId ?? "", {
    query: { enabled: !!user?.telegramId, queryKey: getGetWithdrawalsQueryKey(user?.telegramId ?? "") },
  });

  useEffect(() => {
    if (!user?.telegramId) return;
    fetch(`${apiBase()}/api/creator/${user.telegramId}/cr-summary`, { headers: initHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCrSummary(data); })
      .catch(() => {});
  }, [user?.telegramId]);

  const submitGcWithdrawal = async () => {
    if (!user) return;
    setMsg(null); setGcSubmitting(true);
    try {
      const result = await requestWithdrawal({ telegramId: user.telegramId, gcAmount, usdtWallet }, { headers: { "Idempotency-Key": idem("withdraw-gc", [user.telegramId, gcAmount, usdtWallet]) } });
      setMsg(`GC withdrawal queued: $${result.netUsd.toFixed(4)} USDT.`);
      setGcInput("");
      qc.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      qc.invalidateQueries({ queryKey: getGetWithdrawalsQueryKey(user.telegramId) });
      await refreshUser();
      refetch();
    } catch (err) { setMsg((err as { message?: string })?.message ?? "GC withdrawal failed."); }
    finally { setGcSubmitting(false); }
  };

  const submitCrWithdrawal = async () => {
    if (!user) return;
    setMsg(null); setCrSubmitting(true);
    try {
      const res = await fetch(`${apiBase()}/api/withdrawals/creator`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idem("withdraw-cr", [user.telegramId, crAmount, usdtWallet]), ...initHeaders() },
        body: JSON.stringify({ telegramId: user.telegramId, crAmount, walletAddress: usdtWallet }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "CR withdrawal failed.");
      setMsg(`CR withdrawal queued: ${data.netCr?.toLocaleString?.() ?? crNet.toLocaleString()} CR = $${Number(data.netUsd ?? crNetUsd).toFixed(4)} USDT.`);
      setCrInput("");
      await refreshUser();
    } catch (err) { setMsg(err instanceof Error ? err.message : "CR withdrawal failed."); }
    finally { setCrSubmitting(false); }
  };

  const rows = useMemo(() => {
    const anyHistory = history as any;
    return Array.isArray(anyHistory?.items) ? anyHistory.items : Array.isArray(anyHistory?.withdrawals) ? anyHistory.withdrawals : [];
  }, [history]);

  if (isLoading) return <PageLoader rows={3} />;
  if (isError) return <PageError message="Could not load wallet data" onRetry={refetch} />;

  return <div className="min-h-screen bg-[#05070d] px-3 pt-3 pb-28 text-white">
    <style>{`.wallet-card{background:linear-gradient(160deg,rgba(15,24,42,.84),rgba(6,8,16,.95));border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 55px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(18px)}`}</style>
    <div className="mb-4 flex items-center gap-2"><Wallet size={16} className="text-[#FFD700]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Wallet</span></div>

    <section className="wallet-card mb-4 rounded-[30px] border-[#FFD700]/30 p-4">
      <div className="mb-3 flex items-center gap-2 text-[#FFD700]"><Shield size={16}/><span className="font-black">Your Balance</span></div>
      <div className="grid grid-cols-2 gap-2"><div className="rounded-3xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/8 p-3"><div className="font-mono text-[9px] text-white/36">TC</div><div className="text-3xl font-black text-[#8BC3FF]">{tradeCredits.toLocaleString()}</div></div><div className="rounded-3xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] text-white/36">GC</div><div className="text-3xl font-black text-[#FFD700]">{goldCoins.toLocaleString()}</div><div className="font-mono text-[10px] text-white/35">≈ ${usdGc(goldCoins, gcRate).toFixed(2)} / {inr(usdGc(goldCoins, gcRate))}</div></div></div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-[#FFD700]" style={{ width: `${Math.min(100, (goldCoins / gcMin) * 100)}%` }} /></div>
      <div className="mt-2 font-mono text-[10px] text-white/38">GC min {gcMin.toLocaleString()} · 6% fee · {gcRate.toLocaleString()} GC = $1</div>
    </section>

    <section className="wallet-card mb-4 rounded-[30px] border-[#00F5A0]/30 p-4">
      <div className="mb-2 flex items-center gap-2 text-[#00F5A0]"><Wallet size={16}/><span className="font-black">Creator Balance</span></div>
      <div className="font-mono text-[10px] text-white/42">Earned from referrals and approved content</div>
      <div className="mt-3 rounded-3xl border border-[#00F5A0]/20 bg-[#00F5A0]/8 p-3"><div className="font-mono text-[9px] text-white/38">Available CR</div><div className="text-3xl font-black text-[#00F5A0]">{withdrawableCr.toLocaleString()} CR</div><div className="font-mono text-[10px] text-white/35">≈ ${usdCr(withdrawableCr).toFixed(2)}</div></div>
      <div className="mt-2 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Pending CR</div><div className="font-black text-white">{pendingCr.toLocaleString()}</div><div className="font-mono text-[8px] text-white/30">48hr review</div></div><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/38">Lifetime earned</div><div className="font-black text-white">{totalCrEarned.toLocaleString()}</div></div></div>
      {!creatorPassPaid && <div className="mt-3 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[10px] text-[#00F5A0]">Creator Pass is required for CR withdrawals.</div>}
    </section>

    <section className="wallet-card mb-4 rounded-[30px] p-4">
      <div className="mb-3 flex items-center gap-2 text-white"><ArrowUpRight size={16}/><span className="font-black">Withdraw</span></div>
      <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/38">USDT TRC-20 wallet</label>
      <input value={usdtWallet} onChange={(e) => setUsdtWallet(e.target.value.trim())} placeholder="T... wallet address" className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-white/18"/>
      {usdtWallet && !usdtWallet.startsWith("T") && <div className="mt-2 flex items-center gap-1 font-mono text-[10px] text-[#FFD700]"><AlertTriangle size={12}/>TRC-20 addresses usually start with T.</div>}

      <div className="mt-4 rounded-3xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-3"><div className="mb-2 font-black text-[#FFD700]">Gameplay GC Withdrawal</div><input value={gcInput} onChange={(e) => setGcInput(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder={`Min ${gcMin.toLocaleString()} GC`} className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xl font-black text-white outline-none"/>{gcAmount > 0 && <div className="mt-2 font-mono text-[10px] text-white/45">Net: ${gcNetUsd.toFixed(4)} / {inr(gcNetUsd)} after 6% fee</div>}<button onClick={submitGcWithdrawal} disabled={!canGcWithdraw} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#FFD700] font-black text-black disabled:opacity-35">{gcSubmitting ? <><Loader2 size={16} className="animate-spin"/>Submitting</> : "Withdraw GC"}</button></div>

      <div className="mt-4 rounded-3xl border border-[#00F5A0]/20 bg-[#00F5A0]/7 p-3"><div className="mb-2 font-black text-[#00F5A0]">Creator CR Withdrawal</div><input value={crInput} onChange={(e) => setCrInput(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="Min 1,000 CR" className="w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-xl font-black text-white outline-none"/>{crAmount > 0 && <div className="mt-2 font-mono text-[10px] text-white/45">Net: {crNet.toLocaleString()} CR = ${crNetUsd.toFixed(4)} after 10% fee</div>}<button onClick={submitCrWithdrawal} disabled={!canCrWithdraw} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#00F5A0] font-black text-black disabled:opacity-35">{crSubmitting ? <><Loader2 size={16} className="animate-spin"/>Submitting</> : "Withdraw CR"}</button></div>
    </section>

    {msg && <div className="mb-3 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3 font-mono text-[11px] text-[#00F5A0]">{msg}</div>}

    <section className="wallet-card rounded-[30px] p-4"><div className="mb-3 flex items-center gap-2 text-[#8BC3FF]"><History size={16}/><span className="font-black">History</span><button onClick={() => refetch()} className="ml-auto rounded-full border border-[#8BC3FF]/20 bg-[#8BC3FF]/8 px-3 py-1 font-mono text-[10px] font-black text-[#8BC3FF]"><RefreshCw size={11} className="inline mr-1"/>Refresh</button></div>{rows.length === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-5 text-center font-mono text-[11px] text-white/38">No GC withdrawals yet.</div> : <div className="space-y-2">{rows.map((row: WithdrawalRow, idx: number) => { const tone = statusTone(row.status); const amountGc = row.gcAmount ?? row.amountGc ?? 0; return <div key={row.id ?? idx} className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="flex items-center justify-between"><div><div className="font-mono text-xs font-black text-white">{amountGc.toLocaleString()} GC</div><div className="font-mono text-[10px] text-white/35">${(row.netUsd ?? usdGc(amountGc, gcRate) * (1 - GC_FEE_PCT)).toFixed(4)} USDT</div></div><span className="rounded-full px-2 py-1 font-mono text-[9px] font-black" style={{ color: tone.color, background: tone.bg }}>{tone.label}</span></div></div>; })}</div>}</section>
  </div>;
}

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowUpRight, CheckCircle, Crown, History, Loader2, RefreshCw, Shield, Wallet, Zap } from "lucide-react";
import { TonConnectButton, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { beginCell } from "@ton/core";
import { getGetUserQueryKey, getGetWithdrawalsQueryKey, requestWithdrawal, useGetWithdrawals, useUpdateWallet, useUpgradeToVip, useVerifyWithdrawalFee } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { getVipCountdownLabel } from "@/lib/vipExpiry";
import { PageError, PageLoader } from "@/components/PageStatus";

const FREE_GC_PER_USD = 5000;
const VIP_GC_PER_USD = 2500;
const FREE_MIN_GC = 14000;
const VIP_MIN_GC = 2500;
const FEE_PCT = 0.06;
const FREE_WEEKLY_MAX_USD = 25;
const VIP_WEEKLY_MAX_USD = 100;
const USD_TO_INR_EST = 83;
const TON_MONTHLY_AMOUNT = "1700000000";
const TON_VERIFY_AMOUNT = "200000000";
const KOINARA_TON_WALLET: string | undefined = import.meta.env.VITE_KOINARA_TON_WALLET || import.meta.env.VITE_TON_WALLET || undefined;

type WithdrawSource = "gameplay" | "creator";
type WithdrawalRow = { id?: number | string; status?: string; gcAmount?: number; amountGc?: number; netUsd?: number; txHash?: string };

function commentPayload(comment: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString("base64");
}

function shortAddress(address?: string | null): string {
  if (!address) return "Not connected";
  return address.length <= 14 ? address : `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function usdForGc(gc: number, rate: number): number {
  return gc / rate;
}

function inrForUsd(usd: number): string {
  return `₹${Math.round(usd * USD_TO_INR_EST).toLocaleString()}`;
}

function idempotencyKey(prefix: string, parts: Array<string | number>): string {
  return `${prefix}:${parts.join(":")}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

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
  const queryClient = useQueryClient();
  const walletAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const updateWallet = useUpdateWallet();
  const upgradeToVip = useUpgradeToVip();
  const verifyFee = useVerifyWithdrawalFee();

  const [source, setSource] = useState<WithdrawSource>("gameplay");
  const [usdtWallet, setUsdtWallet] = useState("");
  const [gcInput, setGcInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [withdrawSuccess, setWithdrawSuccess] = useState<{ netUsd: number; eta: string } | null>(null);
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [verifyDone, setVerifyDone] = useState(false);
  const [tonPending, setTonPending] = useState(false);
  const [vipSuccess, setVipSuccess] = useState(false);

  const u = user as any;
  const vipActive = isVipActive(user);
  const vipCountdown = getVipCountdownLabel(user?.vipExpiresAt);
  const goldCoins = user?.goldCoins ?? 0;
  const tradeCredits = user?.tradeCredits ?? 0;
  const referralGc = u?.referralEarnings ?? u?.referralEarningsGc ?? 0;
  const gcPerUsd = vipActive ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const minGc = vipActive ? VIP_MIN_GC : FREE_MIN_GC;
  const weeklyMaxUsd = vipActive ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;
  const hasVerified = user?.hasVerified ?? false;
  const needsVerification = !vipActive && !hasVerified && !verifyDone;

  const gcAmount = parseInt(gcInput.replace(/[^0-9]/g, ""), 10) || 0;
  const usdGross = usdForGc(gcAmount, gcPerUsd);
  const feeUsd = usdGross * FEE_PCT;
  const netUsd = usdGross - feeUsd;
  const belowMin = gcAmount > 0 && gcAmount < minGc;
  const overBalance = gcAmount > goldCoins;
  const progress = Math.min(100, (goldCoins / minGc) * 100);
  const canWithdraw = gcAmount >= minGc && !overBalance && usdtWallet.length >= 10 && !needsVerification && !withdrawSubmitting;

  const { data: withdrawHistory, isLoading, isError, refetch } = useGetWithdrawals(user?.telegramId ?? "", {
    query: { enabled: !!user?.telegramId, queryKey: getGetWithdrawalsQueryKey(user?.telegramId ?? "") },
  });

  useEffect(() => {
    if (!walletAddress || !user || user.walletAddress === walletAddress) return;
    updateWallet.mutateAsync({ telegramId: user.telegramId, data: { walletAddress } })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        refreshUser();
      })
      .catch(() => {});
  }, [walletAddress, user?.telegramId, user?.walletAddress, updateWallet, queryClient, refreshUser]);

  const switchWallet = async () => {
    setMessage(null);
    try {
      if (tonConnectUI.connected) await tonConnectUI.disconnect();
      await tonConnectUI.openModal();
    } catch (err) {
      setMessage((err as { message?: string })?.message ?? "Could not open wallet selector.");
    }
  };

  const buyVip = async () => {
    if (!user || tonPending || vipActive) return;
    if (!walletAddress) { await tonConnectUI.openModal(); return; }
    if (!KOINARA_TON_WALLET) {
      setMessage("TON payments are not configured. Add VITE_TON_WALLET or VITE_KOINARA_TON_WALLET and redeploy frontend.");
      return;
    }
    setTonPending(true); setMessage(null);
    try {
      const memo = `KNR-VIP-monthly-${user.telegramId}`;
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: KOINARA_TON_WALLET, amount: TON_MONTHLY_AMOUNT, payload: commentPayload(memo) }] });
      await new Promise((r) => setTimeout(r, 5000));
      await upgradeToVip.mutateAsync({ telegramId: user.telegramId, data: { plan: "monthly", senderAddress: walletAddress } });
      setVipSuccess(true);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err) { setMessage((err as { message?: string })?.message ?? "VIP activation failed."); }
    finally { setTonPending(false); }
  };

  useEffect(() => {
    if (!user || vipActive || tonPending) return;
    let auto = false;
    try { auto = localStorage.getItem("koinara_auto_vip_checkout") === "1"; } catch {}
    if (!auto) return;
    if (!walletAddress) { tonConnectUI.openModal().catch(() => {}); return; }
    try { localStorage.removeItem("koinara_auto_vip_checkout"); } catch {}
    void buyVip();
  }, [user?.telegramId, walletAddress, vipActive, tonPending]);

  const verifyIdentity = async () => {
    if (!user) return;
    if (!walletAddress) { await tonConnectUI.openModal(); return; }
    if (!KOINARA_TON_WALLET) {
      setMessage("TON payments are not configured. Add VITE_TON_WALLET or VITE_KOINARA_TON_WALLET and redeploy frontend.");
      return;
    }
    setVerifyPending(true); setMessage(null);
    try {
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: KOINARA_TON_WALLET, amount: TON_VERIFY_AMOUNT, payload: commentPayload(`KNR-VERIFY-${user.telegramId}`) }] });
      await new Promise((r) => setTimeout(r, 5000));
      await verifyFee.mutateAsync({ data: { telegramId: user.telegramId, senderAddress: walletAddress } });
      setVerifyDone(true);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err) { setMessage((err as { message?: string })?.message ?? "Verification failed."); }
    finally { setVerifyPending(false); }
  };

  const submitWithdrawal = async () => {
    if (!user) return;
    setMessage(null); setWithdrawSuccess(null); setWithdrawSubmitting(true);
    try {
      const result = await requestWithdrawal({ telegramId: user.telegramId, gcAmount, usdtWallet }, { headers: { "Idempotency-Key": idempotencyKey(`withdraw-${source}`, [user.telegramId, gcAmount, usdtWallet]) } });
      setWithdrawSuccess({ netUsd: result.netUsd, eta: result.estimatedTime });
      setGcInput("");
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetWithdrawalsQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err) { setMessage((err as { message?: string })?.message ?? "Withdrawal failed."); }
    finally { setWithdrawSubmitting(false); }
  };

  const chooseSource = (nextSource: WithdrawSource) => {
    setSource(nextSource);
    setMessage(nextSource === "creator" ? "Referral commissions are paid in GC and withdraw the same way. There is no separate creator wallet." : "Gameplay earnings selected. Use your GC balance for withdrawal.");
  };

  const historyRows = useMemo(() => {
    const anyHistory = withdrawHistory as any;
    return Array.isArray(anyHistory?.items) ? anyHistory.items : Array.isArray(anyHistory?.withdrawals) ? anyHistory.withdrawals : [];
  }, [withdrawHistory]);

  if (isLoading) return <PageLoader rows={3} />;
  if (isError) return <PageError message="Could not load wallet data" onRetry={refetch} />;

  return <div className="min-h-screen bg-[#05070d] px-3 pt-3 pb-28 text-white">
    <style>{`.wallet-card{background:linear-gradient(160deg,rgba(15,24,42,.84),rgba(6,8,16,.95));border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 55px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(18px)}.wallet-gold{border-color:rgba(255,215,0,.30)}.wallet-blue{border-color:rgba(77,163,255,.26)}`}</style>

    <div className="mb-4 flex items-center gap-2"><Wallet size={16} className="text-[#FFD700]"/><span className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">Wallet</span></div>

    <section className="wallet-card wallet-gold mb-4 rounded-[30px] p-4">
      <div className="mb-3 flex items-center gap-2 text-[#FFD700]"><Shield size={16}/><span className="font-black">SECTION 1 — Your Balance</span></div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-3xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/8 p-3"><div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/36">Trade Credits</div><div className="mt-1 text-3xl font-black text-[#8BC3FF]">{tradeCredits.toLocaleString()}</div><div className="font-mono text-[10px] text-white/35">TC · play balance</div></div>
        <div className="rounded-3xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3"><div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/36">Gold Coins</div><div className="mt-1 text-3xl font-black text-[#FFD700]">{goldCoins.toLocaleString()}</div><div className="font-mono text-[10px] text-white/35">≈ ${usdForGc(goldCoins, gcPerUsd).toFixed(2)} / {inrForUsd(usdForGc(goldCoins, gcPerUsd))}</div></div>
      </div>
      <div className="mt-4 flex items-end justify-between"><div className="font-mono text-[10px] text-white/42">Withdrawal progress</div><div className="font-mono text-[10px] text-white/42">{goldCoins.toLocaleString()} / {minGc.toLocaleString()} GC</div></div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] to-[#FFB800]" style={{ width: `${progress}%` }} /></div>
      <div className="mt-2 font-mono text-[10px] leading-relaxed text-white/38">Rate: {vipActive ? "2,500 GC = $1 VIP" : "5,000 GC = $1 free"}. Minimum: {vipActive ? "2,500 GC VIP" : "14,000 GC free"}. Fee: 6%.</div>
    </section>

    <section className="wallet-card mb-4 rounded-3xl p-3">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="font-mono text-[9px] uppercase tracking-[0.18em] text-white/36">Connected TON wallet</div><div className={`truncate font-mono text-sm font-black ${walletAddress ? "text-[#8BC3FF]" : "text-white/35"}`}>{shortAddress(walletAddress)}</div><div className="mt-1 font-mono text-[10px] text-white/35">Use Switch for Tonkeeper, Telegram Wallet, or another TON wallet.</div></div><button onClick={switchWallet} className="shrink-0 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700]"><RefreshCw size={12} className="inline mr-1"/>{walletAddress ? "Switch" : "Connect"}</button></div>
    </section>

    {!vipActive && <section className="wallet-card wallet-gold mb-4 rounded-3xl p-4"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><Crown size={20} className="text-[#FFD700]"/><div><div className="font-black text-[#FFD700]">VIP Monthly</div><div className="font-mono text-[10px] text-white/45">2,500 GC = $1, lower minimum, higher caps.</div></div></div><button onClick={buyVip} disabled={tonPending || !KOINARA_TON_WALLET} className="rounded-2xl bg-[#FFD700] px-4 py-3 font-black text-black disabled:opacity-40">{tonPending ? "Activating" : "Buy VIP"}</button></div></section>}
    {vipActive && vipCountdown && <section className="wallet-card wallet-gold mb-4 flex items-center gap-3 rounded-2xl p-3"><Crown size={18} className="text-[#FFD700]"/><div className="flex-1"><div className="font-black text-[#FFD700]">VIP active</div><div className="font-mono text-[10px] text-white/40">Expires {vipCountdown}</div></div><Zap size={15} className="text-[#FFD700]"/></section>}

    {needsVerification && <section className="mb-4 rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/8 p-4"><div className="flex items-center gap-2 font-black text-[#FF4D6D]"><Shield size={16}/>One-time withdrawal verification</div><p className="mt-2 font-mono text-[11px] text-white/48">Free accounts verify once for $0.99 / 0.2 TON before USDT withdrawal. VIP skips this.</p>{!walletAddress ? <div className="mt-3"><TonConnectButton /></div> : !KOINARA_TON_WALLET ? <div className="mt-3 rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3 font-mono text-[10px] text-[#FF8FA3]"><AlertTriangle size={13} className="inline mr-1"/>TON payments not configured.</div> : <button onClick={verifyIdentity} disabled={verifyPending} className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-[#FF4D6D]/40 bg-[#FF4D6D]/10 font-black text-[#FF8FA3] disabled:opacity-40">{verifyPending ? <><Loader2 size={16} className="animate-spin"/>Waiting for TX</> : "Verify — 0.2 TON / $0.99"}</button>}</section>}

    <AnimatePresence>{vipSuccess && <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="wallet-card wallet-gold mb-3 flex items-center gap-3 rounded-2xl p-3"><Crown size={20} className="text-[#FFD700]"/><div><div className="font-black text-[#FFD700]">VIP activated</div><div className="font-mono text-[10px] text-white/40">Premium wallet benefits unlocked.</div></div></motion.div>}{withdrawSuccess && <motion.div initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="mb-3 rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 p-4"><div className="flex items-center gap-2 font-black text-[#00F5A0]"><CheckCircle size={18}/>Withdrawal queued</div><div className="mt-1 font-mono text-xs text-white/55">${withdrawSuccess.netUsd.toFixed(4)} USDT · {inrForUsd(withdrawSuccess.netUsd)} est. · ETA {withdrawSuccess.eta}</div></motion.div>}</AnimatePresence>
    {message && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-[11px] text-[#FFD700]">{message}</div>}

    <section className="wallet-card mb-4 rounded-[30px] p-4">
      <div className="mb-3 flex items-center gap-2 text-[#FFD700]"><ArrowUpRight size={16}/><span className="font-black">SECTION 2 — Withdraw</span></div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button onClick={() => chooseSource("gameplay")} className={`rounded-3xl border p-3 text-left ${source === "gameplay" ? "border-[#FFD700]/40 bg-[#FFD700]/10" : "border-white/10 bg-white/[0.025]"}`}><div className="font-black text-[#FFD700]">Option A</div><div className="font-black">Gameplay Earnings</div><div className="mt-1 font-mono text-[10px] text-white/40">GC balance: {goldCoins.toLocaleString()}</div></button>
        <button onClick={() => chooseSource("creator")} className={`rounded-3xl border p-3 text-left ${source === "creator" ? "border-[#00F5FF]/40 bg-[#00F5FF]/10" : "border-white/10 bg-white/[0.025]"}`}><div className="font-black text-[#00F5FF]">Option B</div><div className="font-black">Creator & Referral Earnings</div><div className="mt-1 font-mono text-[10px] text-white/40">Referral earned: {referralGc.toLocaleString()} GC</div></button>
      </div>

      <div className="mb-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 font-mono text-[10px] leading-relaxed text-white/45">{source === "creator" ? "Referral commissions are paid in GC and withdraw the same way. There is no separate creator wallet." : "Gameplay GC and referral GC use the same withdrawal rules and same USDT payout flow."}</div>
      <div className="mb-3 grid grid-cols-3 gap-2"><div className="rounded-2xl border border-[#FFD700]/15 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/38">Rate</div><div className="font-black text-[#FFD700]">{gcPerUsd.toLocaleString()}:1</div><div className="font-mono text-[8px] text-white/35">GC per $1</div></div><div className="rounded-2xl border border-[#00F5FF]/15 bg-[#00F5FF]/7 p-3"><div className="font-mono text-[9px] text-white/38">Minimum</div><div className="font-black text-[#00F5FF]">{minGc.toLocaleString()}</div><div className="font-mono text-[8px] text-white/35">GC</div></div><div className="rounded-2xl border border-[#FF4D8D]/15 bg-[#FF4D8D]/7 p-3"><div className="font-mono text-[9px] text-white/38">Fee</div><div className="font-black text-[#FF4D8D]">6%</div><div className="font-mono text-[8px] text-white/35">deducted</div></div></div>

      <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/38">USDT TRC-20 wallet</label>
      <input value={usdtWallet} onChange={(e) => setUsdtWallet(e.target.value.trim())} disabled={needsVerification} placeholder="T... wallet address" className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-white/18 focus:border-[#FFD700]/50 disabled:opacity-45"/>
      <div className="mt-2 grid grid-cols-2 gap-2"><button onClick={() => window.open("https://www.tronlink.org/", "_blank")} className="rounded-xl border border-[#00F5FF]/20 bg-[#00F5FF]/8 px-3 py-2 font-mono text-[10px] font-black text-[#00F5FF]">TronLink helper</button><button onClick={() => window.open("https://www.binance.com/", "_blank")} className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700]">Binance TRC20</button></div>
      {usdtWallet && !usdtWallet.startsWith("T") && <div className="mt-2 flex items-center gap-1 font-mono text-[10px] text-[#FFD700]"><AlertTriangle size={12}/>TRC-20 addresses usually start with T.</div>}

      <div className="mt-4 flex items-center justify-between"><label className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/38">Amount GC</label><button onClick={() => setGcInput(String(goldCoins))} disabled={needsVerification} className="rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-1 font-mono text-[10px] font-black text-[#FFD700] disabled:opacity-40">MAX</button></div>
      <input value={gcInput} onChange={(e) => { setGcInput(e.target.value.replace(/[^0-9]/g, "")); setMessage(null); }} disabled={needsVerification} inputMode="numeric" placeholder={`Min ${minGc.toLocaleString()} GC`} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4 text-2xl font-black text-white outline-none placeholder:text-white/18 focus:border-[#FFD700]/50 disabled:opacity-45"/>
      <div className="mt-2 grid grid-cols-3 gap-2">{[minGc, minGc * 2, goldCoins].filter((v, i, a) => v > 0 && a.indexOf(v) === i).slice(0, 3).map((v) => <button key={v} onClick={() => setGcInput(String(Math.min(v, goldCoins)))} disabled={needsVerification} className="rounded-xl border border-white/10 bg-white/[0.025] py-2 font-mono text-[10px] text-white/48 disabled:opacity-40">{Math.min(v, goldCoins).toLocaleString()}</button>)}</div>

      {gcAmount > 0 && <div className="mt-3 rounded-3xl border border-white/8 bg-white/[0.025] p-4 space-y-2"><div className="flex justify-between font-mono text-xs"><span className="text-white/42">Gross</span><span>${usdGross.toFixed(4)} · {inrForUsd(usdGross)}</span></div><div className="flex justify-between font-mono text-xs"><span className="text-white/42">Fee 6%</span><span className="text-[#FF4D6D]">-${feeUsd.toFixed(4)}</span></div><div className="h-px bg-white/10"/><div className="flex justify-between font-mono"><span className="font-black text-white">You receive</span><span className="font-black text-[#00F5A0]">${netUsd.toFixed(4)} · {inrForUsd(netUsd)}</span></div><div className="flex justify-between font-mono text-[10px]"><span className="text-white/30">Weekly max</span><span className="text-[#FFD700]">${weeklyMaxUsd}/week</span></div></div>}

      {belowMin && <div className="mt-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-[11px] text-[#FFD700]">Need {(minGc - gcAmount).toLocaleString()} more GC to withdraw.</div>}
      {overBalance && <div className="mt-3 rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3 font-mono text-[11px] text-[#FF8FA3]">Amount exceeds your GC balance.</div>}
      <button onClick={submitWithdrawal} disabled={!canWithdraw} className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFB800] font-black text-black disabled:cursor-not-allowed disabled:opacity-35">{withdrawSubmitting ? <><Loader2 size={18} className="animate-spin"/>Submitting</> : needsVerification ? "Verify first" : "Withdraw"}</button>
    </section>

    <section className="wallet-card rounded-[30px] p-4">
      <div className="mb-3 flex items-center gap-2 text-[#8BC3FF]"><History size={16}/><span className="font-black">SECTION 3 — History</span><button onClick={() => refetch()} className="ml-auto rounded-full border border-[#8BC3FF]/20 bg-[#8BC3FF]/8 px-3 py-1 font-mono text-[10px] font-black text-[#8BC3FF]">Refresh</button></div>
      {historyRows.length === 0 ? <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-5 text-center font-mono text-[11px] text-white/38">No withdrawals yet.</div> : <div className="space-y-2">{historyRows.map((row: WithdrawalRow, idx: number) => { const tone = statusTone(row.status); const amountGc = row.gcAmount ?? row.amountGc ?? 0; return <div key={row.id ?? idx} className="rounded-2xl border border-white/8 bg-white/[0.025] p-3"><div className="flex items-center justify-between gap-2"><div><div className="font-mono text-xs font-black text-white">{amountGc.toLocaleString()} GC</div><div className="font-mono text-[10px] text-white/35">${(row.netUsd ?? usdForGc(amountGc, gcPerUsd) * (1 - FEE_PCT)).toFixed(4)} USDT</div></div><span className="rounded-full px-2 py-1 font-mono text-[9px] font-black" style={{ color: tone.color, background: tone.bg }}>{tone.label}</span></div>{row.txHash && <div className="mt-2 truncate font-mono text-[9px] text-white/28">TX {row.txHash}</div>}</div>; })}</div>}
    </section>
  </div>;
}

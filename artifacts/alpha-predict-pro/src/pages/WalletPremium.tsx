import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowUpRight, CheckCircle, Copy, Crown, History, Loader2, RefreshCw, Shield, Sparkles, Users, Wallet, Zap } from "lucide-react";
import { TonConnectButton, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { beginCell } from "@ton/core";
import { getGetUserQueryKey, getGetWithdrawalsQueryKey, requestWithdrawal, useGetWithdrawals, useUpdateWallet, useUpgradeToVip, useVerifyWithdrawalFee } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
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
const TON_MONTHLY_AMOUNT = "1700000000";
const TON_VERIFY_AMOUNT = "200000000";
const KOINARA_TON_WALLET: string | undefined = import.meta.env.VITE_KOINARA_TON_WALLET || import.meta.env.VITE_TON_WALLET || undefined;

type WalletTab = "withdraw" | "history";
type WithdrawalRow = { id?: number | string; status?: string; gcAmount?: number; amountGc?: number; netUsd?: number; txHash?: string };

function makeIdempotencyKey(prefix: string, parts: Array<string | number>): string {
  return `${prefix}:${parts.map((part) => String(part).trim()).join(":")}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function commentPayload(comment: string): string {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell().toBoc().toString("base64");
}

function shortAddress(address?: string | null): string {
  if (!address) return "Not connected";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function statusTone(status = "pending"): { label: string; color: string; bg: string } {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: "Pending", color: "#FFD700", bg: "rgba(255,215,0,.1)" },
    processing: { label: "Processing", color: "#4DA3FF", bg: "rgba(77,163,255,.1)" },
    complete: { label: "Complete", color: "#00F5A0", bg: "rgba(0,245,160,.1)" },
    failed: { label: "Failed", color: "#FF4D6D", bg: "rgba(255,77,109,.1)" },
  };
  return map[status] ?? map.pending;
}

export default function WalletPremium() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const walletAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const updateWallet = useUpdateWallet();
  const upgradeToVip = useUpgradeToVip();
  const verifyFee = useVerifyWithdrawalFee();

  const [tab, setTab] = useState<WalletTab>("withdraw");
  const [usdtWallet, setUsdtWallet] = useState("");
  const [gcInput, setGcInput] = useState("");
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawSuccess, setWithdrawSuccess] = useState<{ netUsd: number; eta: string } | null>(null);
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [verifyDone, setVerifyDone] = useState(false);
  const [tonPending, setTonPending] = useState(false);
  const [vipSuccess, setVipSuccess] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const u = user as any;
  const vipActive = isVipActive(user);
  const vipCountdown = getVipCountdownLabel(user?.vipExpiresAt);
  const goldCoins = user?.goldCoins ?? 0;
  const tradeCredits = user?.tradeCredits ?? 0;
  const referralGc = u?.referralEarnings ?? u?.referralEarningsGc ?? 0;
  const referralLevel1 = u?.referralCount ?? u?.directReferralCount ?? 0;
  const referralLevel2 = u?.level2ReferralCount ?? u?.secondLevelReferralCount ?? 0;
  const gcPerUsd = vipActive ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const minGc = vipActive ? VIP_MIN_GC : FREE_MIN_GC;
  const weeklyMaxUsd = vipActive ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;
  const hasVerified = user?.hasVerified ?? false;
  const needsVerification = !vipActive && !hasVerified && !verifyDone;
  const gcAmount = parseInt(gcInput.replace(/[^0-9]/g, ""), 10) || 0;
  const usdGross = gcAmount / gcPerUsd;
  const feeUsd = usdGross * FEE_PCT;
  const netUsd = usdGross - feeUsd;
  const belowMin = gcAmount > 0 && gcAmount < minGc;
  const overBalance = gcAmount > goldCoins;
  const progress = Math.min(100, (goldCoins / minGc) * 100);
  const canWithdraw = gcAmount >= minGc && !overBalance && usdtWallet.length >= 10 && !needsVerification && !withdrawSubmitting;
  const referralWithdrawReady = referralGc >= minGc && !needsVerification;

  const { data: withdrawHistory, isLoading, isError, refetch } = useGetWithdrawals(user?.telegramId ?? "", {
    query: { enabled: !!user?.telegramId, queryKey: getGetWithdrawalsQueryKey(user?.telegramId ?? "") },
  });

  useEffect(() => {
    if (walletAddress && user && user.walletAddress !== walletAddress) {
      updateWallet.mutateAsync({ telegramId: user.telegramId, data: { walletAddress } }).then(() => {
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        refreshUser();
      }).catch(() => {});
    }
  }, [walletAddress, user?.telegramId, user?.walletAddress, updateWallet, queryClient, refreshUser]);

  const handleSwitchWallet = async () => {
    setWithdrawError(null);
    try {
      if (tonConnectUI.connected) await tonConnectUI.disconnect();
      await tonConnectUI.openModal();
    } catch (err) {
      setWithdrawError((err as { message?: string })?.message ?? "Could not open wallet selector. Please try again.");
    }
  };

  const handleTonVip = async () => {
    if (!user || tonPending || vipActive) return;
    if (!walletAddress) {
      await tonConnectUI.openModal();
      return;
    }
    if (!KOINARA_TON_WALLET) {
      setWithdrawError("TON payments are not configured. Add VITE_TON_WALLET or VITE_KOINARA_TON_WALLET and redeploy frontend.");
      return;
    }
    setTonPending(true);
    setWithdrawError(null);
    try {
      const memo = `KNR-VIP-monthly-${user.telegramId}`;
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: KOINARA_TON_WALLET, amount: TON_MONTHLY_AMOUNT, payload: commentPayload(memo) }] });
      await new Promise((r) => setTimeout(r, 5000));
      await upgradeToVip.mutateAsync({ telegramId: user.telegramId, data: { plan: "monthly", senderAddress: walletAddress } });
      setVipSuccess(true);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err) {
      setWithdrawError((err as { message?: string })?.message ?? "VIP activation failed. Please try again.");
    } finally {
      setTonPending(false);
    }
  };

  useEffect(() => {
    if (!user || vipActive || tonPending) return;
    let shouldAuto = false;
    try { shouldAuto = localStorage.getItem("koinara_auto_vip_checkout") === "1"; } catch {}
    if (!shouldAuto) return;
    if (!walletAddress) {
      tonConnectUI.openModal().catch(() => {});
      return;
    }
    try { localStorage.removeItem("koinara_auto_vip_checkout"); } catch {}
    void handleTonVip();
  }, [user?.telegramId, walletAddress, vipActive, tonPending]);

  const handleVerifyIdentity = async () => {
    if (!user) return;
    if (!walletAddress) {
      await tonConnectUI.openModal();
      return;
    }
    if (!KOINARA_TON_WALLET) {
      setWithdrawError("TON payments are not configured. Add VITE_TON_WALLET or VITE_KOINARA_TON_WALLET and redeploy frontend.");
      return;
    }
    setVerifyPending(true);
    setWithdrawError(null);
    try {
      const payload = commentPayload(`KNR-VERIFY-${user.telegramId}`);
      await tonConnectUI.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: KOINARA_TON_WALLET, amount: TON_VERIFY_AMOUNT, payload }] });
      await new Promise((r) => setTimeout(r, 5000));
      await verifyFee.mutateAsync({ data: { telegramId: user.telegramId, senderAddress: walletAddress } });
      setVerifyDone(true);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err) {
      setWithdrawError((err as { message?: string })?.message ?? "Verification failed. Please try again.");
    } finally {
      setVerifyPending(false);
    }
  };

  const handleWithdraw = async () => {
    if (!user) return;
    setWithdrawError(null);
    setWithdrawSuccess(null);
    setWithdrawSubmitting(true);
    try {
      const result = await requestWithdrawal({ telegramId: user.telegramId, gcAmount, usdtWallet }, { headers: { "Idempotency-Key": makeIdempotencyKey("withdraw", [user.telegramId, gcAmount, usdtWallet]) } });
      setWithdrawSuccess({ netUsd: result.netUsd, eta: result.estimatedTime });
      setGcInput("");
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetWithdrawalsQueryKey(user.telegramId) });
      await refreshUser();
    } catch (err: unknown) {
      setWithdrawError((err as { message?: string })?.message ?? "Withdrawal failed. Please try again.");
    } finally {
      setWithdrawSubmitting(false);
    }
  };

  const startReferralWithdraw = () => {
    setTab("withdraw");
    setGcInput(String(Math.min(referralGc || minGc, goldCoins)));
    setWithdrawError(referralWithdrawReady ? null : needsVerification ? "Verify once or go VIP before withdrawing referral GC." : `Referral withdrawal unlocks at ${minGc.toLocaleString()} GC.`);
  };

  const historyRows = useMemo(() => {
    const anyHistory = withdrawHistory as any;
    return Array.isArray(anyHistory?.items) ? anyHistory.items : Array.isArray(anyHistory?.withdrawals) ? anyHistory.withdrawals : [];
  }, [withdrawHistory]);

  if (isLoading) return <PageLoader rows={3} />;
  if (isError) return <PageError message="Could not load wallet data" onRetry={refetch} />;

  return (
    <div className="min-h-screen px-3 pt-3 pb-28 text-white bg-[#05070d]">
      <style>{`.wallet-glass{background:linear-gradient(160deg,rgba(15,24,42,.84),rgba(6,8,16,.95));border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 55px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(18px)}.wallet-gold{border-color:rgba(255,215,0,.30);box-shadow:0 18px 60px rgba(0,0,0,.45),0 0 34px rgba(255,215,0,.10),inset 0 1px 0 rgba(255,255,255,.08)}.wallet-blue{border-color:rgba(77,163,255,.26);box-shadow:0 18px 60px rgba(0,0,0,.42),0 0 30px rgba(77,163,255,.09),inset 0 1px 0 rgba(255,255,255,.07)}`}</style>

      <section className="wallet-glass wallet-gold rounded-[30px] p-4 mb-3 overflow-hidden relative">
        <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-[#FFD700]/15 blur-3xl" />
        <div className="relative z-10 flex items-start justify-between gap-3">
          <div><div className="inline-flex items-center gap-1.5 rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-2.5 py-1 font-mono text-[9px] font-black tracking-[0.16em] uppercase text-[#FFE266]"><Shield size={11}/>Withdrawal Vault</div><h1 className="text-3xl font-black mt-3 leading-tight">Wallet Center</h1><p className="font-mono text-[10px] text-white/42 mt-1">GC withdrawals · VIP payments · referral cashout</p></div>
          <div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/10 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/42">Cash value</div><div className="font-mono text-xl font-black text-[#FFD700]">${(goldCoins / gcPerUsd).toFixed(2)}</div></div>
        </div>
        <div className="relative z-10 mt-4"><div className="flex items-end justify-between mb-2"><div className="text-3xl font-black">{goldCoins.toLocaleString()} GC</div><div className="font-mono text-sm text-white/45">/ {minGc.toLocaleString()}</div></div><div className="h-3 rounded-full bg-white/8 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] to-[#FFB800] shadow-[0_0_18px_rgba(255,215,0,.38)]" style={{ width: `${progress}%` }}/></div></div>
      </section>

      <section className="grid grid-cols-2 gap-2 mb-3"><div className="wallet-glass wallet-gold rounded-3xl p-3"><div className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/36">Gold Coins</div><div className="font-mono text-3xl font-black text-[#FFD700] mt-1">{goldCoins.toLocaleString()}</div><div className="font-mono text-[10px] text-white/35 mt-1">USDT withdraw balance</div></div><div className="wallet-glass wallet-blue rounded-3xl p-3"><div className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/36">Trade Credits</div><div className="font-mono text-3xl font-black text-[#8BC3FF] mt-1">{tradeCredits.toLocaleString()}</div><div className="font-mono text-[10px] text-white/35 mt-1">Play balance</div></div></section>

      <section className="wallet-glass rounded-3xl p-3 mb-3"><div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3 min-w-0"><div className="h-10 w-10 rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/10 flex items-center justify-center shrink-0"><Wallet size={18} className="text-[#8BC3FF]"/></div><div className="min-w-0"><div className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/36">Connected TON wallet</div><div className={`font-mono text-sm font-black truncate ${walletAddress ? "text-[#8BC3FF]" : "text-white/35"}`}>{shortAddress(walletAddress)}</div><div className="font-mono text-[10px] text-white/35 mt-1 leading-relaxed">Use Switch to choose Tonkeeper, Telegram Wallet, or another TON wallet for purchases.</div></div></div><button onClick={handleSwitchWallet} className="rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700] flex items-center gap-1.5 shrink-0"><RefreshCw size={12}/>{walletAddress ? "Switch" : "Connect"}</button></div></section>

      {!vipActive && <section className="wallet-glass wallet-gold rounded-3xl p-4 mb-3"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="h-11 w-11 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/10 flex items-center justify-center"><Crown size={20} className="text-[#FFD700]"/></div><div><div className="font-black text-[#FFD700]">VIP Monthly</div><div className="font-mono text-[10px] text-white/45">Lower withdrawal minimum, faster ETA, higher caps.</div></div></div><button onClick={handleTonVip} disabled={tonPending || !KOINARA_TON_WALLET} className="rounded-2xl bg-[#FFD700] px-4 py-3 font-black text-black disabled:opacity-40">{tonPending ? "Activating" : "Buy VIP"}</button></div></section>}
      {vipActive && vipCountdown && <section className="wallet-glass wallet-gold rounded-2xl p-3 mb-3 flex items-center gap-3"><Crown size={18} className="text-[#FFD700]"/><div className="flex-1"><div className="font-black text-[#FFD700]">VIP active</div><div className="font-mono text-[10px] text-white/40">Expires {vipCountdown}</div></div><Zap size={15} className="text-[#FFD700]"/></section>}

      {needsVerification && <section className="rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/8 p-4 mb-3"><div className="flex items-center gap-2 text-[#FF4D6D] font-black"><Shield size={16}/>One-time verification</div><p className="font-mono text-[11px] text-white/48 mt-2 leading-relaxed">Free accounts verify once for $0.99 / 0.2 TON before USDT withdrawal. Invite 1 VIP referral or upgrade to skip this step.</p>{!walletAddress ? <div className="mt-3"><TonConnectButton/></div> : !KOINARA_TON_WALLET ? <div className="mt-3 rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3 font-mono text-[10px] text-[#FF8FA3] flex items-center gap-2"><AlertTriangle size={13}/>TON payments not configured.</div> : <button onClick={handleVerifyIdentity} disabled={verifyPending} className="mt-3 w-full h-12 rounded-2xl border border-[#FF4D6D]/40 bg-[#FF4D6D]/10 text-[#FF8FA3] font-black flex items-center justify-center gap-2 disabled:opacity-40">{verifyPending ? <><Loader2 size={16} className="animate-spin"/>Waiting for TX</> : "Verify — 0.2 TON / $0.99"}</button>}</section>}

      <section className="wallet-glass rounded-3xl p-3 mb-3"><div className="grid grid-cols-2 gap-2"><button onClick={() => setTab("withdraw")} className={`h-12 rounded-2xl font-black flex items-center justify-center gap-2 border ${tab === "withdraw" ? "border-[#FFD700] bg-[#FFD700]/12 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/42"}`}><ArrowUpRight size={16}/>Withdraw</button><button onClick={() => { setTab("history"); refetch(); }} className={`h-12 rounded-2xl font-black flex items-center justify-center gap-2 border ${tab === "history" ? "border-[#4DA3FF] bg-[#4DA3FF]/12 text-[#8BC3FF]" : "border-white/10 bg-white/[0.025] text-white/42"}`}><History size={16}/>History</button></div></section>

      <AnimatePresence>{vipSuccess && <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="wallet-glass wallet-gold rounded-2xl p-3 mb-3 flex items-center gap-3"><Crown size={20} className="text-[#FFD700]"/><div><div className="font-black text-[#FFD700]">VIP activated</div><div className="font-mono text-[10px] text-white/40">Premium wallet benefits unlocked.</div></div></motion.div>}{withdrawSuccess && <motion.div initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 p-4 mb-3"><div className="flex items-center gap-2 text-[#00F5A0] font-black"><CheckCircle size={18}/>Withdrawal queued</div><div className="font-mono text-xs text-white/55 mt-1">${withdrawSuccess.netUsd.toFixed(4)} USDT · ETA {withdrawSuccess.eta}</div></motion.div>}</AnimatePresence>

      {tab === "withdraw" ? <section className="space-y-3">
        <section className="wallet-glass rounded-3xl p-4 border-[#00F5FF]/25"><div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2"><Users size={16} className="text-[#00F5FF]"/><span className="font-black text-[#00F5FF]">Referral Withdrawals</span></div><span className={`rounded-full px-2 py-1 font-mono text-[9px] font-black ${referralWithdrawReady ? "bg-[#00F5A0]/10 text-[#00F5A0]" : "bg-white/5 text-white/35"}`}>{referralWithdrawReady ? "Ready" : "Locked"}</span></div><div className="grid grid-cols-3 gap-2 mb-3"><div className="rounded-2xl border border-[#FFD700]/15 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/38">Level 1</div><div className="font-black text-[#FFD700]">{referralLevel1}</div></div><div className="rounded-2xl border border-[#00F5FF]/15 bg-[#00F5FF]/7 p-3"><div className="font-mono text-[9px] text-white/38">Level 2</div><div className="font-black text-[#00F5FF]">{referralLevel2}</div></div><div className="rounded-2xl border border-[#FF4D8D]/15 bg-[#FF4D8D]/7 p-3"><div className="font-mono text-[9px] text-white/38">Earned</div><div className="font-black text-[#FF4D8D]">{referralGc.toLocaleString()}</div></div></div><button onClick={startReferralWithdraw} className="w-full rounded-2xl border border-[#00F5FF]/30 bg-[#00F5FF]/10 py-3 font-black text-[#00F5FF]">Withdraw Referral GC</button></section>

        <section className="wallet-glass rounded-3xl p-4"><div className="flex items-center justify-between mb-2"><div><div className="font-black">Regular GC Withdrawal</div><div className="font-mono text-[10px] text-white/36">USDT TRC-20 payout · manual review</div></div><div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/35">Minimum</div><div className="font-mono text-xs font-black text-[#FFD700]">{minGc.toLocaleString()} GC</div></div></div><label className="font-mono text-[10px] tracking-[0.18em] uppercase text-white/38">USDT TRC-20 wallet</label><input value={usdtWallet} onChange={(e) => setUsdtWallet(e.target.value.trim())} disabled={needsVerification} placeholder="T... wallet address" className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none focus:border-[#FFD700]/50 placeholder:text-white/18 disabled:opacity-45"/><div className="mt-2 grid grid-cols-2 gap-2"><button onClick={() => window.open("https://www.tronlink.org/", "_blank")} className="rounded-xl border border-[#00F5FF]/20 bg-[#00F5FF]/8 px-3 py-2 font-mono text-[10px] font-black text-[#00F5FF]">Suggested: TronLink</button><button onClick={() => window.open("https://www.binance.com/", "_blank")} className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700]">Use Binance TRC20</button></div>{usdtWallet && !usdtWallet.startsWith("T") && <div className="mt-2 font-mono text-[10px] text-[#FFD700] flex items-center gap-1"><AlertTriangle size={12}/>TRC-20 addresses usually start with T.</div>}</section>

        <section className="wallet-glass rounded-3xl p-4"><div className="flex items-center justify-between"><label className="font-mono text-[10px] tracking-[0.18em] uppercase text-white/38">Amount GC</label><button onClick={() => setGcInput(String(goldCoins))} disabled={needsVerification} className="rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-1 font-mono text-[10px] font-black text-[#FFD700] disabled:opacity-40">MAX</button></div><input value={gcInput} onChange={(e) => { setGcInput(e.target.value.replace(/[^0-9]/g, "")); setWithdrawError(null); }} disabled={needsVerification} inputMode="numeric" placeholder={`Min ${minGc.toLocaleString()} GC`} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4 text-2xl font-black text-white outline-none focus:border-[#FFD700]/50 placeholder:text-white/18 disabled:opacity-45"/><div className="grid grid-cols-3 gap-2 mt-2">{[minGc, minGc * 2, goldCoins].filter((v, i, a) => v > 0 && a.indexOf(v) === i).slice(0, 3).map((v) => <button key={v} onClick={() => setGcInput(String(Math.min(v, goldCoins)))} disabled={needsVerification} className="rounded-xl border border-white/10 bg-white/[0.025] py-2 font-mono text-[10px] text-white/48 disabled:opacity-40">{Math.min(v, goldCoins).toLocaleString()}</button>)}</div></section>

        {gcAmount > 0 && <section className="wallet-glass rounded-3xl p-4 space-y-2"><div className="flex justify-between font-mono text-xs"><span className="text-white/42">Gross</span><span>${usdGross.toFixed(4)}</span></div><div className="flex justify-between font-mono text-xs"><span className="text-white/42">Fee {(FEE_PCT * 100).toFixed(0)}%</span><span className="text-[#FF4D6D]">-${feeUsd.toFixed(4)}</span></div><div className="h-px bg-white/10"/><div className="flex justify-between font-mono"><span className="text-white font-black">You receive</span><span className="text-[#00F5A0] font-black">${netUsd.toFixed(4)} USDT</span></div><div className="flex justify-between font-mono text-[10px]"><span className="text-white/30">Weekly max</span><span className="text-[#FFD700]">${weeklyMaxUsd}/week</span></div></section>}

        {belowMin && <div className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-[11px] text-[#FFD700]">Need {(minGc - gcAmount).toLocaleString()} more GC to withdraw.</div>}{overBalance && <div className="rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3 font-mono text-[11px] text-[#FF8FA3]">Amount exceeds your GC balance.</div>}{withdrawError && <div className="rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3 font-mono text-[11px] text-[#FF8FA3]">{withdrawError}</div>}
        <button onClick={handleWithdraw} disabled={!canWithdraw} className="w-full h-15 rounded-3xl border border-[#FFD700]/40 bg-gradient-to-r from-[#FFD700] to-[#FFB800] text-black font-black text-lg shadow-[0_0_28px_rgba(255,215,0,.30)] disabled:opacity-35 disabled:grayscale flex items-center justify-center gap-2">{withdrawSubmitting ? <><Loader2 size={18} className="animate-spin"/>Processing</> : <><ArrowUpRight size={18}/>Withdraw {gcAmount > 0 ? gcAmount.toLocaleString() : "GC"}</>}</button><div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 font-mono text-[10px] text-white/32 flex items-start gap-2"><Sparkles size={13} className="text-[#FFD700] shrink-0 mt-0.5"/>USDT withdrawals are manually reviewed and sent to your TRC-20 wallet inside the processing window.</div>
      </section> : <section className="wallet-glass rounded-3xl p-3"><div className="flex items-center justify-between mb-3"><div className="font-black">Withdrawal History</div><button onClick={() => refetch()} className="font-mono text-[10px] text-[#8BC3FF]">Refresh</button></div>{historyRows.length === 0 ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 text-center"><History size={28} className="mx-auto text-white/25 mb-2"/><div className="font-mono text-sm text-white/42">No withdrawals yet.</div></div> : <div className="space-y-2">{historyRows.map((row: WithdrawalRow) => { const tone = statusTone(row.status); const amount = row.amountGc ?? row.gcAmount ?? 0; return <div key={row.id ?? `${amount}-${row.txHash ?? row.status}`} className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="flex items-center justify-between"><div className="font-mono text-sm font-black text-white">{Number(amount).toLocaleString()} GC</div><div className="rounded-full px-2 py-1 font-mono text-[9px] font-black" style={{ color: tone.color, background: tone.bg }}>{tone.label}</div></div><div className="font-mono text-[10px] text-white/38 mt-1">Net ${Number(row.netUsd ?? 0).toFixed(4)} USDT</div>{row.txHash && <button onClick={() => { navigator.clipboard?.writeText(row.txHash!); setCopied(row.txHash!); }} className="mt-2 font-mono text-[10px] text-[#8BC3FF] flex items-center gap-1"><Copy size={11}/>{copied === row.txHash ? "Copied" : "Copy TX"}</button>}</div>; })}</div>}</section>}
    </div>
  );
}

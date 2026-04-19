import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wallet, Lock, Crown, CheckCircle, ArrowUpRight, AlertTriangle,
  Shield, Coins, Gem, Clock, History, ChevronRight, Loader2,
  XCircle, RefreshCw, Zap, Copy, Check
} from "lucide-react";
import { TonConnectButton, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { beginCell } from "@ton/core";
import {
  useUpgradeToVip, useUpdateWallet,
  useRequestWithdrawal, useGetWithdrawals, useVerifyWithdrawalFee,
  getGetUserQueryKey, getGetWithdrawalsQueryKey,
} from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";
import { getVipCountdownLabel } from "@/lib/vipExpiry";
import { ConfettiBurst } from "@/components/particles/ConfettiBurst";

// ─── Constants ────────────────────────────────────────────────────────────────
const FREE_GC_PER_USD = 4000;
const VIP_GC_PER_USD  = 2500;
const FREE_MIN_GC     = 10000;
const VIP_MIN_GC      = 2500;
const FREE_WEEKLY_MAX_USD = 25;
const VIP_WEEKLY_MAX_USD  = 100;
const FEE_PCT = 0.025;
const VIP_FEE_TC = 500;
const MILESTONE_GC = 10000;

const TON_WEEKLY_AMOUNT  = "500000000";
const TON_MONTHLY_AMOUNT = "1500000000";
const TON_VERIFY_AMOUNT  = "20000000"; // 0.02 TON ≈ $1.99 verification fee
const KOINARA_TON_WALLET: string | undefined = import.meta.env.VITE_KOINARA_TON_WALLET || undefined;

type VipTab = "tc" | "ton";
type WalletTab = "withdraw" | "history";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function useVipCountdown(vipExpiresAt?: string | null) {
  const [remaining, setRemaining] = useState<string | null>(null);
  useEffect(() => {
    if (!vipExpiresAt) return;
    const update = () => {
      setRemaining(getVipCountdownLabel(vipExpiresAt));
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, [vipExpiresAt]);
  return remaining;
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    pending:    { label: "Pending",    color: "#f5c518", bg: "rgba(245,197,24,0.1)"  },
    processing: { label: "Processing", color: "#00f0ff", bg: "rgba(0,240,255,0.1)"  },
    complete:   { label: "Complete",   color: "#00ff88", bg: "rgba(0,255,136,0.1)"  },
    failed:     { label: "Failed",     color: "#ff2d78", bg: "rgba(255,45,120,0.1)" },
  };
  return map[status] ?? map.pending;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function WalletPage() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const walletAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();

  const upgradeToVip   = useUpgradeToVip();
  const updateWallet   = useUpdateWallet();
  const requestWithdrawal = useRequestWithdrawal();
  const verifyFee      = useVerifyWithdrawalFee();

  const [showVipModal, setShowVipModal] = useState(false);
  const [vipSuccess, setVipSuccess]     = useState(false);
  const [vipTab, setVipTab]             = useState<VipTab>("tc");
  const [tonPending, setTonPending]     = useState(false);
  const [tonPlan, setTonPlan]           = useState<"weekly" | "monthly">("weekly");

  const [walletTab, setWalletTab] = useState<WalletTab>("withdraw");
  const [usdtWallet, setUsdtWallet] = useState("");
  const [gcInput, setGcInput]       = useState("");
  const [withdrawError, setWithdrawError]   = useState<string | null>(null);
  const [withdrawSuccess, setWithdrawSuccess] = useState<{ netUsd: number; eta: string } | null>(null);
  const [verifyPending, setVerifyPending]   = useState(false);
  const [verifyDone, setVerifyDone]         = useState(false);
  const [copiedTxHash, setCopiedTxHash]     = useState<number | null>(null);
  const [showWithdrawConfetti, setShowWithdrawConfetti] = useState(false);

  const vipCountdown = useVipCountdown(user?.vipExpiresAt);

  const { data: withdrawHistory, refetch: refetchHistory } = useGetWithdrawals(
    user?.telegramId ?? "",
    { query: { enabled: !!user?.telegramId, queryKey: getGetWithdrawalsQueryKey(user?.telegramId ?? "") } },
  );

  // Auto-bind TON wallet to user profile
  useEffect(() => {
    if (walletAddress && user && !user.walletAddress) {
      updateWallet.mutateAsync({
        telegramId: user.telegramId,
        data: { walletAddress },
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      }).catch(() => {});
    }
  }, [walletAddress, user]);

  const vipActive   = isVipActive(user);
  const gcPerUsd    = vipActive ? VIP_GC_PER_USD  : FREE_GC_PER_USD;
  const minGc       = vipActive ? VIP_MIN_GC       : FREE_MIN_GC;
  const weeklyMaxUsd = vipActive ? VIP_WEEKLY_MAX_USD : FREE_WEEKLY_MAX_USD;

  const gcAmount   = parseInt(gcInput.replace(/[^0-9]/g, ""), 10) || 0;
  const usdGross   = gcAmount / gcPerUsd;
  const feeUsd     = usdGross * FEE_PCT;
  const netUsd     = usdGross - feeUsd;
  const feeGc      = Math.floor(gcAmount * FEE_PCT);
  const netGc      = gcAmount - feeGc;
  const belowMin   = gcAmount > 0 && gcAmount < minGc;
  const overBalance = gcAmount > (user?.goldCoins ?? 0);

  const goldCoins     = user?.goldCoins ?? 0;
  const tradeCredits  = user?.tradeCredits ?? 0;
  const totalGcEarned = user?.totalGcEarned ?? 0;
  const milestoneProgress = Math.min(totalGcEarned / MILESTONE_GC, 1);
  const hasVerified   = user?.hasVerified ?? false;
  const needsVerification = !vipActive && !hasVerified && !verifyDone;

  // ── VIP TC upgrade
  const handleVipUpgrade = async () => {
    if (!user) return;
    try {
      await upgradeToVip.mutateAsync({ telegramId: user.telegramId, data: { plan: "tc" } });
      setVipSuccess(true);
      setShowVipModal(false);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {}
  };

  // ── VIP TON upgrade
  const handleTonVip = async () => {
    if (!user || !walletAddress || !KOINARA_TON_WALLET) return;
    setTonPending(true);
    try {
      const amount = tonPlan === "weekly" ? TON_WEEKLY_AMOUNT : TON_MONTHLY_AMOUNT;
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address: KOINARA_TON_WALLET, amount }],
      });
      await upgradeToVip.mutateAsync({
        telegramId: user.telegramId,
        data: { plan: tonPlan, senderAddress: walletAddress },
      });
      setVipSuccess(true);
      setShowVipModal(false);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {
    } finally {
      setTonPending(false);
    }
  };

  // ── Free tier verification fee (0.02 TON)
  const handleVerifyIdentity = async () => {
    if (!walletAddress || !KOINARA_TON_WALLET || !user) return;
    setVerifyPending(true);
    try {
      // Per-user comment (text_comment cell) — cryptographically binds the
      // on-chain tx to this Telegram user so it cannot be reused by an attacker.
      const comment = `KNR-VERIFY-${user.telegramId}`;
      const commentPayload = beginCell()
        .storeUint(0, 32)
        .storeStringTail(comment)
        .endCell()
        .toBoc()
        .toString("base64");

      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address: KOINARA_TON_WALLET, amount: TON_VERIFY_AMOUNT, payload: commentPayload }],
      });
      // Confirm the payment on the backend — sets hasVerified=true in the DB
      await verifyFee.mutateAsync({
        data: { telegramId: user.telegramId, senderAddress: walletAddress },
      });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetWithdrawalsQueryKey(user.telegramId) });
      setVerifyDone(true);
    } catch {
    } finally {
      setVerifyPending(false);
    }
  };

  // ── Submit withdrawal
  const handleWithdraw = async () => {
    if (!user) return;
    setWithdrawError(null);
    setWithdrawSuccess(null);
    try {
      const result = await requestWithdrawal.mutateAsync({
        data: {
          telegramId: user.telegramId,
          gcAmount,
          usdtWallet,
        },
      });
      setWithdrawSuccess({ netUsd: result.netUsd, eta: result.estimatedTime });
      setGcInput("");
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetWithdrawalsQueryKey(user.telegramId) });
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "Withdrawal failed. Please try again.";
      setWithdrawError(msg);
    }
  };

  const canWithdraw = gcAmount >= minGc && !overBalance && usdtWallet.length >= 10 && !needsVerification;

  useEffect(() => {
    if (!withdrawSuccess || !user) return;
    const key = `koinara:firstWithdrawalCelebrated:${user.telegramId}`;
    let alreadyCelebrated = false;
    try {
      alreadyCelebrated = localStorage.getItem(key) === "1";
    } catch {
      alreadyCelebrated = false;
    }
    if (!alreadyCelebrated) {
      setShowWithdrawConfetti(true);
      try {
        localStorage.setItem(key, "1");
      } catch {
        // ignore storage failures
      }
      const timer = setTimeout(() => setShowWithdrawConfetti(false), 1200);
      return () => clearTimeout(timer);
    }
    return;
  }, [withdrawSuccess, user]);

  return (
    <div className="relative flex flex-col min-h-screen bg-transparent p-4 pb-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-5">
        <Wallet size={16} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
        <span className="font-mono text-xs text-white/65 tracking-[0.16em] uppercase">Withdrawal Vault</span>
      </div>

      <ConfettiBurst active={showWithdrawConfetti} onComplete={() => setShowWithdrawConfetti(false)} />

      {/* VIP Activated Toast */}
      <AnimatePresence>
        {vipSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-4 p-4 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/10 flex items-center gap-3 app-card"
          >
            <Crown size={20} className="text-[#f5c518]" />
            <div>
              <div className="font-mono text-sm font-black text-[#f5c518]">VIP ACTIVATED!</div>
              <div className="font-mono text-[10px] text-white/50">Better rates · Faster payouts · Higher limits</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* VIP Status Banner */}
      {vipActive && vipCountdown && (
        <div
          className="flex items-center gap-3 p-3 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/8 mb-4 app-card"
          style={{ boxShadow: "0 0 20px rgba(255,215,0,0.15)" }}
        >
          <Crown size={18} className="text-[#FFD700] drop-shadow-[0_0_8px_#FFD700]" />
          <div className="flex-1">
            <div className="font-mono text-xs font-black text-[#FFD700]">VIP ACTIVE</div>
            <div className="font-mono text-[10px] text-white/40">Expires in {vipCountdown}</div>
          </div>
          <Clock size={12} className="text-[#FFD700]/60" />
        </div>
      )}

      {/* Balance Cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-4 rounded-2xl border app-card" style={{
          borderColor: "rgba(255,215,0,0.35)",
          background: "linear-gradient(165deg, rgba(255,215,0,0.09), rgba(10,12,18,0.88))",
          boxShadow: "0 0 25px rgba(255,215,0,0.22)",
        }}>
          <div className="font-mono text-[9px] text-white/40 tracking-widest mb-1">GOLD COINS</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-lg">🪙</span>
            <span className="font-mono text-2xl font-black text-[#FFD700]">{goldCoins.toLocaleString()}</span>
          </div>
          <div className="font-mono text-[10px] text-white/40">≈ ${(goldCoins / gcPerUsd).toFixed(2)} USD</div>
          <div className="font-mono text-[9px] text-white/25 mt-1">Withdrawable</div>
        </div>
        <div className="p-4 rounded-2xl border app-card" style={{
          borderColor: "rgba(77,163,255,0.34)",
          background: "linear-gradient(165deg, rgba(77,163,255,0.08), rgba(10,12,18,0.88))",
          boxShadow: "0 0 20px rgba(77,163,255,0.2)",
        }}>
          <div className="font-mono text-[9px] text-white/40 tracking-widest mb-1">TRADE CREDITS</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-lg">🔵</span>
            <span className="font-mono text-2xl font-black text-[#8BC3FF]">{tradeCredits.toLocaleString()}</span>
          </div>
          <div className="font-mono text-[10px] text-white/40">Bet &amp; Earn</div>
          <div className="font-mono text-[9px] text-white/25 mt-1">Non-withdrawable</div>
        </div>
      </div>

      {/* Rate Info */}
      <div className="flex items-center justify-between px-3 py-2 rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/6 mb-4">
        <div className="flex items-center gap-2">
          <Coins size={13} className="text-[#FFD700]" />
          <span className="font-mono text-[10px] text-white/50">
            {vipActive ? "VIP Rate: 2,500 GC = $1" : "Free Rate: 4,000 GC = $1"}
          </span>
        </div>
        {!vipActive && (
          <button
            onClick={() => setShowVipModal(true)}
            className="pressable font-mono text-[9px] font-black text-[#FFD700] border border-[#FFD700]/45 px-2 py-1 rounded-full"
          >
            UPGRADE VIP
          </button>
        )}
      </div>

      {/* Tab Bar */}
      <div className="flex gap-2 mb-4">
        {(["withdraw", "history"] as WalletTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => { setWalletTab(tab); if (tab === "history") refetchHistory(); }}
            className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold border transition-all flex items-center justify-center gap-1.5 ${
              walletTab === tab
                ? "border-[#f5c518] text-[#f5c518] bg-[#f5c518]/10"
                : "border-white/10 text-white/40 bg-white/[0.02]"
            }`}
          >
            {tab === "withdraw" ? <ArrowUpRight size={12} /> : <History size={12} />}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ── WITHDRAW TAB ── */}
      {walletTab === "withdraw" && (
        <div className="space-y-4">
          {/* Withdrawal Success */}
          <AnimatePresence>
            {withdrawSuccess && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="p-4 rounded-xl border-2 border-[#00ff88] bg-[#00ff88]/10"
              >
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle size={16} className="text-[#00ff88]" />
                  <span className="font-mono text-sm font-black text-[#00ff88]">WITHDRAWAL QUEUED</span>
                </div>
                <div className="font-mono text-xs text-white/60">
                  ${withdrawSuccess.netUsd.toFixed(4)} USDT · ETA: {withdrawSuccess.eta}
                </div>
                <button
                  onClick={() => setWithdrawSuccess(null)}
                  className="mt-2 font-mono text-[10px] text-white/30"
                >
                  Dismiss
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Verification Gate (free unverified users) */}
          {needsVerification && (
            <div className="p-4 rounded-xl border-2 border-[#ff2d78]/60 bg-[#ff2d78]/5">
              <div className="flex items-center gap-2 mb-2">
                <Shield size={14} className="text-[#ff2d78]" />
                <span className="font-mono text-xs font-black text-[#ff2d78]">ONE-TIME VERIFICATION REQUIRED</span>
              </div>
              <div className="font-mono text-[11px] text-white/50 mb-3">
                A one-time $1.99 verification fee (0.02 TON) is required to unlock USDT withdrawals for free accounts.
                VIP users skip this step.
              </div>
              {!walletAddress ? (
                <div className="flex flex-col gap-2">
                  <div className="font-mono text-[10px] text-white/30">Connect your TON wallet first:</div>
                  <TonConnectButton />
                </div>
              ) : !KOINARA_TON_WALLET ? (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
                  <AlertTriangle size={12} className="text-red-400" />
                  <span className="font-mono text-[10px] text-red-400">TON payments not configured. Contact support.</span>
                </div>
              ) : (
                <button
                  onClick={handleVerifyIdentity}
                  disabled={verifyPending}
                  className="w-full py-3 rounded-xl border-2 border-[#ff2d78] font-mono text-sm font-black text-[#ff2d78] bg-[#ff2d78]/10 disabled:opacity-40 flex items-center justify-center gap-2"
                  style={{ boxShadow: "0 0 15px rgba(255,45,120,0.2)" }}
                >
                  {verifyPending ? (
                    <><Loader2 size={14} className="animate-spin" /> WAITING FOR TX...</>
                  ) : (
                    <>VERIFY IDENTITY — 0.02 TON ($1.99)</>
                  )}
                </button>
              )}
              <div className="mt-2 text-center">
                <button
                  onClick={() => setShowVipModal(true)}
                  className="font-mono text-[10px] text-[#f5c518]/60"
                >
                  Skip verification with VIP →
                </button>
              </div>
            </div>
          )}

          {/* USDT Wallet Input */}
          <div>
            <label className="font-mono text-[10px] text-white/40 tracking-widest block mb-1.5">
              USDT TRC-20 WALLET ADDRESS
            </label>
            <input
              type="text"
              value={usdtWallet}
              onChange={(e) => setUsdtWallet(e.target.value.trim())}
              placeholder="T... (TRC-20 address)"
              className="w-full px-3 py-3 rounded-xl bg-white/[0.04] border border-white/10 font-mono text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-[#f5c518]/50"
              disabled={needsVerification}
            />
            {usdtWallet && !usdtWallet.startsWith("T") && (
              <div className="flex items-center gap-1 mt-1">
                <AlertTriangle size={10} className="text-yellow-500" />
                <span className="font-mono text-[10px] text-yellow-500">TRC-20 addresses start with "T"</span>
              </div>
            )}
          </div>

          {/* GC Amount Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="font-mono text-[10px] text-white/40 tracking-widest">AMOUNT (GC)</label>
              <button
                onClick={() => setGcInput(String(goldCoins))}
                className="font-mono text-[10px] text-[#f5c518]/60 border border-[#f5c518]/20 px-1.5 py-0.5 rounded"
                disabled={needsVerification}
              >
                MAX
              </button>
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={gcInput}
              onChange={(e) => { setGcInput(e.target.value.replace(/[^0-9]/g, "")); setWithdrawError(null); setWithdrawSuccess(null); }}
              placeholder={`Min ${minGc.toLocaleString()} GC`}
              className="w-full px-3 py-3 rounded-xl bg-white/[0.04] border border-white/10 font-mono text-base font-bold text-white placeholder:text-white/20 focus:outline-none focus:border-[#f5c518]/50"
              disabled={needsVerification}
            />

            {/* Quick amounts */}
            <div className="flex gap-2 mt-2">
              {[minGc, minGc * 2, minGc * 5].filter(v => v <= goldCoins + 1).slice(0, 3).map(v => (
                <button
                  key={v}
                  onClick={() => setGcInput(String(Math.min(v, goldCoins)))}
                  disabled={needsVerification}
                  className="flex-1 py-1.5 rounded-lg border border-white/10 font-mono text-[10px] text-white/40 hover:border-[#f5c518]/30 hover:text-[#f5c518]/60 transition-all disabled:opacity-40"
                >
                  {v.toLocaleString()}
                </button>
              ))}
            </div>
          </div>

          {/* Fee Breakdown */}
          {gcAmount >= minGc && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3 rounded-xl border border-white/10 bg-white/[0.03] space-y-1.5"
            >
              <div className="flex justify-between">
                <span className="font-mono text-[11px] text-white/40">Gross amount</span>
                <span className="font-mono text-[11px] text-white">${usdGross.toFixed(4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[11px] text-white/40">Platform fee (2.5%)</span>
                <span className="font-mono text-[11px] text-[#ff2d78]">-${feeUsd.toFixed(4)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[11px] text-white/40">GC deducted</span>
                <span className="font-mono text-[11px] text-white">{gcAmount.toLocaleString()} GC</span>
              </div>
              <div className="border-t border-white/10 my-1" />
              <div className="flex justify-between">
                <span className="font-mono text-xs font-black text-white">You receive</span>
                <span className="font-mono text-sm font-black text-[#00ff88]">${netUsd.toFixed(4)} USDT</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[10px] text-white/30">Net GC</span>
                <span className="font-mono text-[10px] text-white/50">{netGc.toLocaleString()} GC</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[10px] text-white/30">Processing time</span>
                <span className="font-mono text-[10px] text-white/50">{vipActive ? "~4 hours" : "48–72 hours"}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[10px] text-white/30">Weekly cap remaining</span>
                <span className="font-mono text-[10px] text-[#f5c518]">
                  {withdrawHistory
                    ? `$${(withdrawHistory.weeklyRemainingGc / gcPerUsd).toFixed(2)} of $${weeklyMaxUsd}`
                    : `$${weeklyMaxUsd}/wk`}
                </span>
              </div>
            </motion.div>
          )}

          {/* Validation Errors */}
          {belowMin && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/8">
              <AlertTriangle size={12} className="text-yellow-500 shrink-0" />
              <span className="font-mono text-[11px] text-yellow-500">
                Min: {minGc.toLocaleString()} GC (${(minGc / gcPerUsd).toFixed(2)}). Need {(minGc - gcAmount).toLocaleString()} more GC.
              </span>
            </div>
          )}
          {overBalance && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/8">
              <XCircle size={12} className="text-red-400 shrink-0" />
              <span className="font-mono text-[11px] text-red-400">
                Exceeds balance. You have {goldCoins.toLocaleString()} GC.
              </span>
            </div>
          )}
          {withdrawError && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-red-500/30 bg-red-500/8">
              <XCircle size={12} className="text-red-400 shrink-0 mt-0.5" />
              <span className="font-mono text-[11px] text-red-400">{withdrawError}</span>
            </div>
          )}

          {/* VIP instant queue badge */}
          {vipActive && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#f5c518]/30 bg-[#f5c518]/8 mb-2">
              <Zap size={11} className="text-[#f5c518]" />
              <span className="font-mono text-[10px] text-[#f5c518] font-bold">INSTANT QUEUE</span>
              <span className="font-mono text-[9px] text-white/30 ml-1">VIP withdrawals skip the 48hr wait</span>
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleWithdraw}
            disabled={!canWithdraw || requestWithdrawal.isPending}
            data-testid="btn-withdraw-submit"
            className="w-full py-4 rounded-xl border-2 border-[#f5c518] font-mono text-sm font-black text-[#f5c518] bg-[#f5c518]/10 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
            style={canWithdraw ? { boxShadow: "0 0 20px rgba(245,197,24,0.25)" } : {}}
          >
            {requestWithdrawal.isPending ? (
              <><Loader2 size={16} className="animate-spin" /> PROCESSING...</>
            ) : (
              <><ArrowUpRight size={16} /> WITHDRAW {gcAmount > 0 ? `${gcAmount.toLocaleString()} GC` : "GC"} → USDT</>
            )}
          </button>

          {/* Info footer */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 p-3 rounded-lg border border-white/8 bg-white/[0.02]">
              <Shield size={12} className="text-white/30 shrink-0" />
              <span className="font-mono text-[10px] text-white/30">
                USDT sent to your TRC-20 address · Manually processed by our team · Sent within processing window
              </span>
            </div>
            {!vipActive && (
              <button
                onClick={() => setShowVipModal(true)}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-[#f5c518]/20 bg-[#f5c518]/5"
              >
                <div className="flex items-center gap-2">
                  <Crown size={12} className="text-[#f5c518]" />
                  <span className="font-mono text-[11px] text-[#f5c518]">VIP: 2,500 GC/$1 · $1 min · 4hr payout</span>
                </div>
                <ChevronRight size={12} className="text-[#f5c518]/40" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── HISTORY TAB ── */}
      {walletTab === "history" && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="font-mono text-xs text-white/40 tracking-widest">WITHDRAWAL HISTORY</span>
            <button
              onClick={() => refetchHistory()}
              className="flex items-center gap-1 font-mono text-[10px] text-white/30"
            >
              <RefreshCw size={10} />Refresh
            </button>
          </div>

          {!withdrawHistory || withdrawHistory.withdrawals.length === 0 ? (
            <div className="flex flex-col items-center py-12 text-center">
              <History size={32} className="text-white/10 mb-3" />
              <div className="font-mono text-sm text-white/20">No withdrawals yet</div>
              <div className="font-mono text-[10px] text-white/10 mt-1">Your withdrawal history will appear here</div>
            </div>
          ) : (
            <div className="space-y-2">
              {withdrawHistory.withdrawals.map((entry) => {
                const badge = statusBadge(entry.status);
                const statusText: Record<string, string> = {
                  pending: "Waiting in queue — your withdrawal will be processed soon.",
                  processing: "Payment being sent — USDT is on its way to your wallet.",
                  complete: "Payout complete — USDT has been sent to your wallet.",
                  failed: "Payout failed — please contact support with your withdrawal ID.",
                };
                return (
                  <div
                    key={entry.id}
                    className="p-3 rounded-xl border border-white/10 bg-white/[0.02]"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono text-xs font-bold text-white">
                        {entry.amountGc.toLocaleString()} GC → ${entry.netUsd.toFixed(4)} USDT
                      </span>
                      <span
                        className="font-mono text-[10px] font-black px-2 py-0.5 rounded-full flex items-center gap-1"
                        style={{ color: badge.color, background: badge.bg }}
                      >
                        {entry.status === "processing" && (
                          <Loader2 size={8} className="animate-spin" />
                        )}
                        {badge.label}
                      </span>
                    </div>
                    <div className="font-mono text-[9px] text-white/30 mb-1.5">
                      {statusText[entry.status] ?? ""}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] font-mono text-white/30">
                      <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
                      <span>·</span>
                      <span>{entry.walletAddress.slice(0, 6)}...{entry.walletAddress.slice(-4)}</span>
                      <span>·</span>
                      <span className="capitalize">{entry.tier}</span>
                    </div>
                    {entry.txHash && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="font-mono text-[9px] text-white/20">
                          TX: {entry.txHash.slice(0, 10)}...{entry.txHash.slice(-6)}
                        </span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(entry.txHash ?? "");
                            setCopiedTxHash(entry.id);
                            setTimeout(() => setCopiedTxHash(null), 2000);
                          }}
                          className="flex items-center gap-1 font-mono text-[9px] text-[#00f0ff]/50 hover:text-[#00f0ff]"
                        >
                          {copiedTxHash === entry.id
                            ? <><Check size={9} />Copied</>
                            : <><Copy size={9} />Copy</>
                          }
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TON Wallet Section */}
      <div className="mt-4 p-4 rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={14} className="text-white/50" />
          <span className="font-mono text-xs text-white/60 tracking-wider">TON WALLET</span>
          <span className="font-mono text-[9px] text-white/20">(VIP subscription payments)</span>
        </div>
        {walletAddress ? (
          <div className="flex items-center gap-2">
            <CheckCircle size={16} className="text-[#00f0ff]" />
            <span className="font-mono text-xs text-[#00f0ff]">
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-6)}
            </span>
          </div>
        ) : (
          <div>
            <div className="font-mono text-xs text-white/40 mb-3">Connect to pay for VIP via TON</div>
            <TonConnectButton />
          </div>
        )}
      </div>

      {/* VIP Upgrade Modal */}
      <AnimatePresence>
        {showVipModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center bg-black/80"
            onClick={() => setShowVipModal(false)}
          >
            <motion.div
              initial={{ y: 240, opacity: 0.8 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 240, opacity: 0.8 }}
              transition={{ type: "spring", stiffness: 260, damping: 28 }}
              className="w-full max-w-[420px] p-6 rounded-t-3xl border-t-2 border-[#FFD700]/65"
              style={{
                background: "radial-gradient(120% 120% at 50% 0%, rgba(255,215,0,0.12), rgba(10,10,15,0.98) 42%, #0a0a0f 100%)",
                boxShadow: "0 -28px 90px rgba(255,215,0,0.24)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center">
                <Crown size={36} className="text-[#FFD700] mb-2 drop-shadow-[0_0_16px_#FFD700]" />
                <div className="font-mono text-xl font-black text-white mb-1 tracking-[0.12em]">ACTIVATE VIP</div>
                <div className="font-mono text-xs text-white/40 mb-4">
                  $4.99/wk · $14.99/mo · cancel anytime
                </div>

                {/* Perks */}
                <div className="w-full grid grid-cols-2 gap-2 mb-4">
                  {[
                    "2,500 GC = $1 rate",
                    "No verification fee",
                    "$1 min withdrawal",
                    "$100/week limit",
                    "~4hr payout time",
                    "1,500 TC daily bonus",
                    "6,000 GC daily cap",
                    "25 ads/day",
                  ].map(perk => (
                    <div key={perk} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/8">
                      <CheckCircle size={10} className="text-[#FFD700] shrink-0" />
                      <span className="font-mono text-[10px] text-white text-left">{perk}</span>
                    </div>
                  ))}
                </div>

                {/* Tab selector */}
                <div className="flex w-full gap-2 mb-4">
                  <button
                    onClick={() => setVipTab("tc")}
                    className={`flex-1 py-2 rounded-xl font-mono text-xs font-bold border transition-all ${
                      vipTab === "tc"
                        ? "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/15"
                        : "border-white/10 text-white/40"
                    }`}
                  >
                    🔵 Pay TC
                  </button>
                  <button
                    onClick={() => setVipTab("ton")}
                    className={`flex-1 py-2 rounded-xl font-mono text-xs font-bold border transition-all ${
                      vipTab === "ton"
                        ? "border-[#FFD700] text-[#FFD700] bg-[#FFD700]/15"
                        : "border-white/10 text-white/40"
                    }`}
                  >
                    <Gem size={11} className="inline mr-1" />TON
                  </button>
                </div>

                {vipTab === "tc" && (
                  <div className="w-full">
                    {tradeCredits < VIP_FEE_TC && (
                      <div className="flex items-center gap-2 mb-3 p-2 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
                        <AlertTriangle size={12} className="text-yellow-500" />
                        <span className="font-mono text-[10px] text-yellow-500">
                          Need {(VIP_FEE_TC - tradeCredits).toLocaleString()} more TC
                        </span>
                      </div>
                    )}
                    <button
                      onClick={handleVipUpgrade}
                      disabled={tradeCredits < VIP_FEE_TC || upgradeToVip.isPending}
                      className="w-full py-4 rounded-2xl border-2 border-[#00f0ff] font-mono text-base font-black text-[#00f0ff] bg-[#00f0ff]/10 disabled:opacity-40 pressable"
                      style={{ boxShadow: tradeCredits >= VIP_FEE_TC ? "0 0 20px rgba(0,240,255,0.3)" : "none" }}
                      data-testid="btn-upgrade-tc"
                    >
                {upgradeToVip.isPending ? "ACTIVATING..." : `PAY ${VIP_FEE_TC} TC — 7 DAYS`}
                    </button>
                  </div>
                )}

                {vipTab === "ton" && (
                  <div className="w-full space-y-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setTonPlan("weekly")}
                        className={`flex-1 p-3 rounded-2xl border-2 text-left transition-all ${
                          tonPlan === "weekly" ? "border-[#FFD700] bg-[#FFD700]/10" : "border-white/10 bg-white/[0.02]"
                        }`}
                      >
                        <div className="font-mono text-xs font-black text-white">7 Days</div>
                        <div className="font-mono text-[10px] text-white/40">0.5 TON · $4.99/week</div>
                      </button>
                      <button
                        onClick={() => setTonPlan("monthly")}
                        className={`flex-1 p-3 rounded-2xl border-2 text-left relative transition-all ${
                          tonPlan === "monthly" ? "border-[#FFD700] bg-[#FFD700]/10" : "border-white/10 bg-white/[0.02]"
                        }`}
                      >
                        <div className="absolute -top-2 right-2 bg-[#FFD700] text-black font-mono text-[8px] px-1.5 py-0.5 rounded-full font-black">BEST VALUE</div>
                        <div className="font-mono text-xs font-black text-white">30 Days</div>
                        <div className="font-mono text-[10px] text-white/40">1.5 TON · $14.99/month</div>
                      </button>
                    </div>
                    {!walletAddress ? (
                      <div className="flex flex-col items-center gap-2">
                        <div className="font-mono text-[10px] text-white/40">Connect TON wallet to pay</div>
                        <TonConnectButton />
                      </div>
                    ) : !KOINARA_TON_WALLET ? (
                      <div className="flex items-center gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10">
                        <AlertTriangle size={14} className="text-red-400 shrink-0" />
                        <div className="font-mono text-[10px] text-red-400">TON payments are not configured. Contact support.</div>
                      </div>
                    ) : (
                      <button
                        onClick={handleTonVip}
                        disabled={tonPending || upgradeToVip.isPending}
                        className="w-full py-4 rounded-2xl border-2 border-[#FFD700] font-mono text-base font-black text-black disabled:opacity-40 pressable"
                        style={{
                          background: "linear-gradient(135deg, #FFE88A, #FFD700 45%, #E1AF00)",
                          boxShadow: "0 0 22px rgba(255,215,0,0.38)",
                        }}
                        data-testid="btn-upgrade-ton"
                      >
                        {tonPending ? "WAITING FOR TX..." : `PAY ${tonPlan === "weekly" ? "0.5" : "1.5"} TON — ${tonPlan === "weekly" ? "7" : "30"} DAYS`}
                      </button>
                    )}
                  </div>
                )}

                {/* Milestone progress (for free users) */}
                {!vipActive && (
                  <div className="w-full mt-4 p-3 rounded-xl border border-white/10 bg-white/5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-[10px] text-white/50">GC Milestone</span>
                      <span className="font-mono text-[10px] text-white/50">{totalGcEarned.toLocaleString()} / {MILESTONE_GC.toLocaleString()}</span>
                    </div>
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${milestoneProgress * 100}%` }}
                        className="h-full rounded-full"
                        style={{ background: "linear-gradient(90deg, #ff2d78, #f5c518)" }}
                      />
                    </div>
                    <div className="font-mono text-[9px] text-white/25 mt-1">
                      Auto-unlock free trial at {MILESTONE_GC.toLocaleString()} lifetime GC
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

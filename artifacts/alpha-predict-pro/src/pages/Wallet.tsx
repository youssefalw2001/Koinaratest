import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, Lock, Crown, CheckCircle, ArrowUpRight, AlertTriangle, Shield, Coins, Gem, Clock } from "lucide-react";
import { TonConnectButton, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { useUpgradeToVip, useUpdateWallet, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { isVipActive } from "@/lib/vipActive";

const GC_TO_USD = 0.00025;
const VIP_FEE_TC = 500;
const MILESTONE_GC = 10000;

const TON_WEEKLY_AMOUNT = "500000000";
const TON_MONTHLY_AMOUNT = "1500000000";
// Fail-closed: if the env var is not set at build time, TON payments are disabled.
// Never fall back to a default address — that would send user funds to an unknown wallet.
const KOINARA_TON_WALLET: string | undefined = import.meta.env.VITE_KOINARA_TON_WALLET || undefined;

type VipTab = "tc" | "ton";

function useVipCountdown(vipExpiresAt?: string | null) {
  const [remaining, setRemaining] = useState<string | null>(null);
  useEffect(() => {
    if (!vipExpiresAt) return;
    const update = () => {
      const diff = new Date(vipExpiresAt).getTime() - Date.now();
      if (diff <= 0) { setRemaining(null); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setRemaining(d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`);
    };
    update();
    const timer = setInterval(update, 60000);
    return () => clearInterval(timer);
  }, [vipExpiresAt]);
  return remaining;
}

export default function WalletPage() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const walletAddress = useTonAddress();
  const [tonConnectUI] = useTonConnectUI();
  const upgradeToVip = useUpgradeToVip();
  const updateWallet = useUpdateWallet();
  const [showVipModal, setShowVipModal] = useState(false);
  const [vipSuccess, setVipSuccess] = useState(false);
  const [vipTab, setVipTab] = useState<VipTab>("tc");
  const [tonPending, setTonPending] = useState(false);
  const [tonPlan, setTonPlan] = useState<"weekly" | "monthly">("weekly");

  const vipCountdown = useVipCountdown(user?.vipExpiresAt);

  useEffect(() => {
    if (walletAddress && user && !user.walletAddress) {
      updateWallet.mutateAsync({
        telegramId: user.telegramId,
        data: { walletAddress }
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      }).catch(() => {});
    }
  }, [walletAddress, user]);

  const handleVipUpgrade = async () => {
    if (!user) return;
    try {
      await upgradeToVip.mutateAsync({ telegramId: user.telegramId, data: { plan: "tc" } });
      setVipSuccess(true);
      setShowVipModal(false);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {}
  };

  const handleTonVip = async () => {
    if (!user || !walletAddress) return;
    // Fail-closed: refuse to send if the operator wallet isn't configured.
    if (!KOINARA_TON_WALLET) {
      console.error("[Koinara] VITE_KOINARA_TON_WALLET is not set — TON payments disabled.");
      return;
    }
    setTonPending(true);
    try {
      const amount = tonPlan === "weekly" ? TON_WEEKLY_AMOUNT : TON_MONTHLY_AMOUNT;
      await tonConnectUI.sendTransaction({
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{ address: KOINARA_TON_WALLET, amount }],
      });
      // After the transaction is sent, pass the sender's wallet address to the backend.
      // The backend resolves it to a raw address and scans the sender's recent transactions
      // on-chain to find and verify the matching payment.
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

  const goldCoins = user?.goldCoins ?? 0;
  const tradeCredits = user?.tradeCredits ?? 0;
  const totalGcEarned = user?.totalGcEarned ?? 0;
  const usdValue = (goldCoins * GC_TO_USD).toFixed(2);
  const canAffordVip = tradeCredits >= VIP_FEE_TC;
  const milestoneProgress = Math.min(totalGcEarned / MILESTONE_GC, 1);
  const vipActive = isVipActive(user);

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-6">
        <Wallet size={16} className="text-[#f5c518] drop-shadow-[0_0_6px_#f5c518]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Koinara Wallet</span>
      </div>

      <AnimatePresence>
        {vipSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-4 p-4 rounded-xl border-2 border-[#f5c518] bg-[#f5c518]/10 flex items-center gap-3"
          >
            <Crown size={20} className="text-[#f5c518]" />
            <div>
              <div className="font-mono text-sm font-black text-[#f5c518]">VIP ACTIVATED!</div>
              <div className="font-mono text-[10px] text-white/50">6,000 GC daily cap · bet up to 5,000 TC — VIP active</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* VIP Status Banner */}
      {vipActive && vipCountdown && (
        <div
          className="flex items-center gap-3 p-3 rounded-xl border-2 border-[#f5c518]/60 bg-[#f5c518]/6 mb-4"
          style={{ boxShadow: "0 0 20px rgba(245,197,24,0.15)" }}
        >
          <Crown size={18} className="text-[#f5c518] drop-shadow-[0_0_8px_#f5c518]" />
          <div className="flex-1">
            <div className="font-mono text-xs font-black text-[#f5c518]">VIP ACTIVE</div>
            <div className="font-mono text-[10px] text-white/40">Expires in {vipCountdown}</div>
          </div>
          <div className="flex items-center gap-1">
            <Clock size={12} className="text-[#f5c518]/60" />
            <span className="font-mono text-[10px] text-[#f5c518]/60">{vipCountdown}</span>
          </div>
        </div>
      )}

      {/* Dual Balance Cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div
          className="p-4 rounded-2xl border-2"
          style={{
            borderColor: "#f5c518",
            background: "rgba(245,197,24,0.05)",
            boxShadow: "0 0 25px rgba(245,197,24,0.2)",
          }}
        >
          <div className="font-mono text-[9px] text-white/40 tracking-widest mb-1">GOLD COINS</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-lg">🪙</span>
            <span className="font-mono text-2xl font-black text-[#f5c518]">{goldCoins.toLocaleString()}</span>
          </div>
          <div className="font-mono text-[10px] text-white/40">≈ ${usdValue} USD</div>
          <div className="font-mono text-[9px] text-white/25 mt-1">Withdrawable</div>
        </div>
        <div
          className="p-4 rounded-2xl border-2"
          style={{
            borderColor: "#00f0ff",
            background: "rgba(0,240,255,0.04)",
            boxShadow: "0 0 20px rgba(0,240,255,0.15)",
          }}
        >
          <div className="font-mono text-[9px] text-white/40 tracking-widest mb-1">TRADE CREDITS</div>
          <div className="flex items-center gap-1 mb-1">
            <span className="text-lg">🔵</span>
            <span className="font-mono text-2xl font-black text-[#00f0ff]">{tradeCredits.toLocaleString()}</span>
          </div>
          <div className="font-mono text-[10px] text-white/40">Bet & Earn</div>
          <div className="font-mono text-[9px] text-white/25 mt-1">Non-withdrawable</div>
        </div>
      </div>

      {/* Lifetime stats */}
      <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-white/10 bg-white/[0.02] mb-4">
        <Coins size={14} className="text-[#f5c518]" />
        <span className="font-mono text-xs text-white/50">Lifetime GC earned:</span>
        <span className="font-mono text-sm font-bold text-[#f5c518]">{totalGcEarned.toLocaleString()}</span>
      </div>

      {/* TON Wallet */}
      <div className="p-4 rounded-xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={14} className="text-white/50" />
          <span className="font-mono text-xs text-white/60 tracking-wider">TON WALLET</span>
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
            <div className="font-mono text-xs text-white/40 mb-3">Connect TON wallet to enable USDT withdrawal</div>
            <TonConnectButton />
          </div>
        )}
      </div>

      {/* Withdrawal Section */}
      <div className="p-4 rounded-xl border-2 mb-4" style={{
        borderColor: vipActive ? "#f5c518" : "#ff2d78",
        background: vipActive ? "rgba(245,197,24,0.03)" : "rgba(255,45,120,0.03)",
      }}>
        <div className="flex items-center gap-2 mb-3">
          <ArrowUpRight size={14} style={{ color: vipActive ? "#f5c518" : "#ff2d78" }} />
          <span className="font-mono text-xs tracking-wider" style={{ color: vipActive ? "#f5c518" : "#ff2d78" }}>
            WITHDRAWAL (USDT TRC-20)
          </span>
        </div>

        {!vipActive ? (
          <div className="flex flex-col items-center py-5">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center border-2 border-[#ff2d78] mb-4"
              style={{ boxShadow: "0 0 20px rgba(255,45,120,0.4)" }}
            >
              <Lock size={24} className="text-[#ff2d78]" />
            </div>
            <div className="font-mono text-sm font-black text-white mb-1">WITHDRAWAL LOCKED</div>
            <div className="font-mono text-xs text-white/40 text-center mb-4">
              VIP required — unlocks GC→USDT withdrawal
            </div>
            <div className="w-full space-y-3">
              <button
                onClick={() => setShowVipModal(true)}
                className="w-full py-3 rounded-xl border-2 border-[#f5c518] font-mono text-sm font-black text-[#f5c518] bg-[#f5c518]/10"
                style={{ boxShadow: "0 0 15px rgba(245,197,24,0.2)" }}
                data-testid="btn-open-vip-modal"
              >
                ACTIVATE VIP — FROM {VIP_FEE_TC} TC
              </button>
              <div className="p-3 rounded-xl border border-white/10 bg-white/5">
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
                  Auto-unlock at {MILESTONE_GC.toLocaleString()} lifetime GC
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 rounded-lg border border-[#f5c518]/30 bg-[#f5c518]/5">
              <CheckCircle size={16} className="text-[#f5c518]" />
              <span className="font-mono text-xs text-[#f5c518]">VIP — Withdrawals unlocked</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg border border-white/10 bg-white/[0.03] mb-2">
              <span className="font-mono text-xs text-white/50">Available to withdraw</span>
              <span className="font-mono text-sm font-bold text-[#f5c518]">{goldCoins.toLocaleString()} GC</span>
            </div>
            {walletAddress ? (
              <button
                className="w-full py-3 rounded-xl border-2 border-[#f5c518] font-mono text-sm font-black text-[#f5c518] bg-[#f5c518]/10"
                style={{ boxShadow: "0 0 15px rgba(245,197,24,0.2)" }}
              >
                WITHDRAW ${usdValue} USDT
              </button>
            ) : (
              <div className="flex items-center gap-2 p-3 rounded-lg border border-white/10">
                <AlertTriangle size={14} className="text-white/40" />
                <span className="font-mono text-xs text-white/40">Connect TON wallet above to withdraw</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rate Card */}
      <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="font-mono text-[10px] text-white/30 tracking-widest mb-2">CONVERSION RATE</div>
        <div className="flex items-center gap-2">
          <span className="text-xs">🪙</span>
          <span className="font-mono text-xs text-white/60">4,000 Gold Coins = $1.00 USDT</span>
        </div>
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
              initial={{ y: 200 }}
              animate={{ y: 0 }}
              exit={{ y: 200 }}
              className="w-full max-w-[420px] p-6 rounded-t-3xl border-t-2 border-[#f5c518] bg-black"
              style={{ boxShadow: "0 -20px 60px rgba(245,197,24,0.3)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center">
                <Crown size={36} className="text-[#f5c518] mb-2 drop-shadow-[0_0_15px_#f5c518]" />
                <div className="font-mono text-xl font-black text-white mb-1">ACTIVATE VIP</div>
                <div className="font-mono text-xs text-white/40 mb-4">
                  $4.99/wk · $14.99/mo · cancel anytime
                </div>

                {/* Perks */}
                <div className="w-full grid grid-cols-2 gap-2 mb-4">
                  {["2× payout multiplier", "1,500 TC daily bonus", "6,000 GC daily cap", "Max 5,000 TC bet", "Instant withdrawal queue", "$1 minimum withdrawal", "20% referral commission", "Content rewards unlocked", "25 ads/day"].map(perk => (
                    <div key={perk} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#f5c518]/20 bg-[#f5c518]/5">
                      <CheckCircle size={10} className="text-[#f5c518] shrink-0" />
                      <span className="font-mono text-[10px] text-white text-left">{perk}</span>
                    </div>
                  ))}
                </div>

                {/* Tab selector */}
                <div className="flex w-full gap-2 mb-4">
                  <button
                    onClick={() => setVipTab("tc")}
                    className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold border transition-all ${
                      vipTab === "tc"
                        ? "border-[#00f0ff] text-[#00f0ff] bg-[#00f0ff]/15"
                        : "border-white/10 text-white/40"
                    }`}
                  >
                    🔵 Pay TC
                  </button>
                  <button
                    onClick={() => setVipTab("ton")}
                    className={`flex-1 py-2 rounded-lg font-mono text-xs font-bold border transition-all ${
                      vipTab === "ton"
                        ? "border-[#f5c518] text-[#f5c518] bg-[#f5c518]/15"
                        : "border-white/10 text-white/40"
                    }`}
                  >
                    <Gem size={11} className="inline mr-1" />TON
                  </button>
                </div>

                {vipTab === "tc" && (
                  <div className="w-full">
                    {!canAffordVip && (
                      <div className="flex items-center gap-2 mb-3 p-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10">
                        <AlertTriangle size={12} className="text-yellow-500" />
                        <span className="font-mono text-[10px] text-yellow-500">
                          Need {(VIP_FEE_TC - tradeCredits).toLocaleString()} more TC
                        </span>
                      </div>
                    )}
                    <button
                      onClick={handleVipUpgrade}
                      disabled={!canAffordVip || upgradeToVip.isPending}
                      className="w-full py-4 rounded-xl border-2 border-[#00f0ff] font-mono text-base font-black text-[#00f0ff] bg-[#00f0ff]/10 disabled:opacity-40"
                      style={{ boxShadow: canAffordVip ? "0 0 20px rgba(0,240,255,0.3)" : "none" }}
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
                        className={`flex-1 p-3 rounded-xl border-2 text-left transition-all ${
                          tonPlan === "weekly" ? "border-[#f5c518] bg-[#f5c518]/10" : "border-white/10 bg-white/[0.02]"
                        }`}
                      >
                        <div className="font-mono text-xs font-black text-white">7 Days</div>
                        <div className="font-mono text-[10px] text-white/40">0.5 TON · $4.99/week</div>
                      </button>
                      <button
                        onClick={() => setTonPlan("monthly")}
                        className={`flex-1 p-3 rounded-xl border-2 text-left relative transition-all ${
                          tonPlan === "monthly" ? "border-[#f5c518] bg-[#f5c518]/10" : "border-white/10 bg-white/[0.02]"
                        }`}
                      >
                        <div className="absolute -top-2 right-2 bg-[#ff2d78] text-white font-mono text-[8px] px-1.5 py-0.5 rounded font-black">BEST VALUE</div>
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
                        className="w-full py-4 rounded-xl border-2 border-[#f5c518] font-mono text-base font-black text-[#f5c518] bg-[#f5c518]/15 disabled:opacity-40"
                        style={{ boxShadow: "0 0 20px rgba(245,197,24,0.3)" }}
                        data-testid="btn-upgrade-ton"
                      >
                        {tonPending ? "WAITING FOR TX..." : `PAY ${tonPlan === "weekly" ? "0.5" : "1.5"} TON — ${tonPlan === "weekly" ? "7" : "30"} DAYS`}
                      </button>
                    )}
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

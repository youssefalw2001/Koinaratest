import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, Lock, Crown, CheckCircle, ArrowUpRight, AlertTriangle, Shield, Coins } from "lucide-react";
import { TonConnectButton, useTonAddress } from "@tonconnect/ui-react";
import { useUpgradeToVip, useUpdateWallet, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";

const GC_TO_USD = 0.00025; // 4,000 GC = $1.00
const VIP_FEE_TC = 500;
const MILESTONE_GC = 10000;

export default function WalletPage() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const walletAddress = useTonAddress();
  const upgradeToVip = useUpgradeToVip();
  const updateWallet = useUpdateWallet();
  const [showVipModal, setShowVipModal] = useState(false);
  const [vipSuccess, setVipSuccess] = useState(false);

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

  const goldCoins = user?.goldCoins ?? 0;
  const tradeCredits = user?.tradeCredits ?? 0;
  const totalGcEarned = user?.totalGcEarned ?? 0;
  const usdValue = (goldCoins * GC_TO_USD).toFixed(2);
  const canAffordVip = tradeCredits >= VIP_FEE_TC;
  const milestoneProgress = Math.min(totalGcEarned / MILESTONE_GC, 1);

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
              <div className="font-mono text-[10px] text-white/50">3,000 GC daily cap · bet up to 5,000 TC — VIP active</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dual Balance Cards */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* Gold Coins */}
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
        {/* Trade Credits */}
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
        borderColor: user?.isVip ? "#f5c518" : "#ff2d78",
        background: user?.isVip ? "rgba(245,197,24,0.03)" : "rgba(255,45,120,0.03)",
      }}>
        <div className="flex items-center gap-2 mb-3">
          <ArrowUpRight size={14} style={{ color: user?.isVip ? "#f5c518" : "#ff2d78" }} />
          <span className="font-mono text-xs tracking-wider" style={{ color: user?.isVip ? "#f5c518" : "#ff2d78" }}>
            WITHDRAWAL (USDT TRC-20)
          </span>
        </div>

        {!user?.isVip ? (
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
                <Crown size={40} className="text-[#f5c518] mb-3 drop-shadow-[0_0_15px_#f5c518]" />
                <div className="font-mono text-xl font-black text-white mb-1">ACTIVATE VIP</div>
                <div className="font-mono text-xs text-white/40 mb-6">
                  Pay {VIP_FEE_TC} TC for 7-day VIP access — or use TON for longer plans
                </div>
                <div className="w-full space-y-2 mb-4">
                  {["3,000 GC daily cap (vs 800)", "Max bet 5,000 TC (vs 1,000)", "Withdrawal access", "VIP-only quests", "Streak TC bonus +50%"].map(perk => (
                    <div key={perk} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#f5c518]/30 bg-[#f5c518]/5">
                      <CheckCircle size={12} className="text-[#f5c518]" />
                      <span className="font-mono text-xs text-white">{perk}</span>
                    </div>
                  ))}
                </div>
                {!canAffordVip && (
                  <div className="flex items-center gap-2 mb-4 p-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 w-full">
                    <AlertTriangle size={12} className="text-yellow-500" />
                    <span className="font-mono text-[10px] text-yellow-500">
                      Need {(VIP_FEE_TC - tradeCredits).toLocaleString()} more Trade Credits
                    </span>
                  </div>
                )}
                <button
                  onClick={handleVipUpgrade}
                  disabled={!canAffordVip || upgradeToVip.isPending}
                  className="w-full py-4 rounded-xl border-2 border-[#f5c518] font-mono text-base font-black text-[#f5c518] bg-[#f5c518]/15 disabled:opacity-40"
                  style={{ boxShadow: canAffordVip ? "0 0 20px rgba(245,197,24,0.4)" : "none" }}
                >
                  {upgradeToVip.isPending ? "ACTIVATING..." : `PAY ${VIP_FEE_TC} TC — 7 DAYS`}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, Lock, Crown, CheckCircle, ArrowUpRight, Zap, Shield, AlertTriangle } from "lucide-react";
import { TonConnectButton, useTonAddress } from "@tonconnect/ui-react";
import { useUpgradeToVip, useUpdateWallet, getGetUserQueryKey } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const POINTS_TO_USD = 0.001;
const VIP_FEE_POINTS = 500;
const MILESTONE_POINTS = 10000;

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
      await upgradeToVip.mutateAsync({ telegramId: user.telegramId });
      setVipSuccess(true);
      setShowVipModal(false);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch {}
  };

  const points = user?.points ?? 0;
  const totalEarned = user?.totalEarned ?? 0;
  const usdValue = (points * POINTS_TO_USD).toFixed(2);
  const canAffordVip = points >= VIP_FEE_POINTS;
  const milestoneProgress = Math.min(totalEarned / MILESTONE_POINTS, 1);

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-6">
        <Wallet size={16} className="text-[#ff2d78] drop-shadow-[0_0_6px_#ff2d78]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Sovereign Wallet</span>
      </div>

      {/* VIP Success Banner */}
      <AnimatePresence>
        {vipSuccess && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-4 p-4 rounded-xl border-2 border-[#00f0ff] bg-[#00f0ff]/10 flex items-center gap-3"
          >
            <Crown size={20} className="text-[#00f0ff]" />
            <div>
              <div className="font-mono text-sm font-black text-[#00f0ff]">VIP STATUS ACTIVATED</div>
              <div className="font-mono text-[10px] text-white/50">You now earn 2x daily rewards</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Balance Card */}
      <div
        className="p-5 rounded-2xl border-2 mb-4"
        style={{
          borderColor: user?.isVip ? "#ff2d78" : "#00f0ff",
          background: user?.isVip ? "rgba(255,45,120,0.05)" : "rgba(0,240,255,0.05)",
          boxShadow: user?.isVip ? "0 0 30px rgba(255,45,120,0.2)" : "0 0 30px rgba(0,240,255,0.2)",
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] text-white/40 tracking-widest mb-1">ALPHA POINTS</div>
            <div className="font-mono text-4xl font-black text-white">{points.toLocaleString()}</div>
          </div>
          {user?.isVip ? (
            <div className="flex flex-col items-center gap-1">
              <Crown size={28} className="text-[#ff2d78] drop-shadow-[0_0_10px_#ff2d78]" />
              <span className="font-mono text-[10px] text-[#ff2d78] font-black tracking-widest">VIP</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <Zap size={28} className="text-[#00f0ff] drop-shadow-[0_0_10px_#00f0ff]" />
              <span className="font-mono text-[10px] text-[#00f0ff] tracking-widest">FREE</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-white/10 pt-3">
          <div>
            <div className="font-mono text-[9px] text-white/30 tracking-widest">USD VALUE</div>
            <div className="font-mono text-xl font-bold text-white">${usdValue}</div>
          </div>
          <div>
            <div className="font-mono text-[9px] text-white/30 tracking-widest">TOTAL EARNED</div>
            <div className="font-mono text-xl font-bold text-white">{totalEarned.toLocaleString()} AP</div>
          </div>
        </div>
      </div>

      {/* TON Wallet Connect */}
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
            <div className="font-mono text-xs text-white/40 mb-3">Connect your TON wallet to enable withdrawals</div>
            <TonConnectButton />
          </div>
        )}
      </div>

      {/* Withdrawal Section */}
      <div className="p-4 rounded-xl border-2 mb-4" style={{
        borderColor: user?.isVip ? "#00f0ff" : "#ff2d78",
        background: user?.isVip ? "rgba(0,240,255,0.03)" : "rgba(255,45,120,0.03)",
      }}>
        <div className="flex items-center gap-2 mb-3">
          <ArrowUpRight size={14} style={{ color: user?.isVip ? "#00f0ff" : "#ff2d78" }} />
          <span className="font-mono text-xs tracking-wider" style={{ color: user?.isVip ? "#00f0ff" : "#ff2d78" }}>
            WITHDRAWAL
          </span>
        </div>

        {!user?.isVip ? (
          <>
            {/* Lock State */}
            <div className="flex flex-col items-center py-6">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center border-2 border-[#ff2d78] mb-4"
                style={{ boxShadow: "0 0 20px rgba(255,45,120,0.4)" }}
              >
                <Lock size={28} className="text-[#ff2d78]" />
              </div>
              <div className="font-mono text-sm font-black text-white mb-1">WITHDRAWAL LOCKED</div>
              <div className="font-mono text-xs text-white/40 text-center mb-4">
                VIP verification required to access withdrawals
              </div>

              {/* Unlock Options */}
              <div className="w-full space-y-3">
                <button
                  onClick={() => setShowVipModal(true)}
                  className="w-full py-3 rounded-xl border-2 border-[#ff2d78] font-mono text-sm font-black text-[#ff2d78] bg-[#ff2d78]/10"
                  style={{ boxShadow: "0 0 15px rgba(255,45,120,0.2)" }}
                  data-testid="btn-upgrade-vip"
                >
                  PAY {VIP_FEE_POINTS} AP — UNLOCK VIP
                </button>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="font-mono text-[9px] text-white/30">OR</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
                <div className="p-3 rounded-xl border border-white/10 bg-white/5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-xs text-white/50">Milestone Progress</span>
                    <span className="font-mono text-xs text-white/50">{totalEarned.toLocaleString()} / {MILESTONE_POINTS.toLocaleString()}</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${milestoneProgress * 100}%` }}
                      className="h-full rounded-full"
                      style={{ background: "linear-gradient(90deg, #ff2d78, #00f0ff)" }}
                    />
                  </div>
                  <div className="font-mono text-[10px] text-white/30 mt-1">
                    Earn {MILESTONE_POINTS.toLocaleString()} lifetime points to auto-unlock
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* VIP Withdrawal UI */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 p-3 rounded-lg border border-[#00f0ff]/30 bg-[#00f0ff]/5">
                <CheckCircle size={16} className="text-[#00f0ff]" />
                <span className="font-mono text-xs text-[#00f0ff]">Withdrawal unlocked — VIP member</span>
              </div>
              {walletAddress ? (
                <button
                  className="w-full py-3 rounded-xl border-2 border-[#00f0ff] font-mono text-sm font-black text-[#00f0ff] bg-[#00f0ff]/10"
                  style={{ boxShadow: "0 0 15px rgba(0,240,255,0.2)" }}
                  data-testid="btn-withdraw"
                >
                  WITHDRAW ${usdValue} TO WALLET
                </button>
              ) : (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-white/10">
                  <AlertTriangle size={14} className="text-white/40" />
                  <span className="font-mono text-xs text-white/40">Connect TON wallet above to withdraw</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Rate Card */}
      <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02]">
        <div className="font-mono text-[10px] text-white/30 tracking-widest mb-2">CONVERSION RATE</div>
        <div className="flex items-center gap-2">
          <Zap size={12} className="text-[#00f0ff]" />
          <span className="font-mono text-xs text-white/60">1,000 Alpha Points = $1.00 USD</span>
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
              className="w-full max-w-[420px] p-6 rounded-t-3xl border-t-2 border-[#ff2d78] bg-black"
              style={{ boxShadow: "0 -20px 60px rgba(255,45,120,0.4)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex flex-col items-center text-center">
                <Crown size={40} className="text-[#ff2d78] mb-3 drop-shadow-[0_0_15px_#ff2d78]" />
                <div className="font-mono text-xl font-black text-white mb-1">ACTIVATE VIP</div>
                <div className="font-mono text-xs text-white/40 mb-6">
                  Pay {VIP_FEE_POINTS} Alpha Points to unlock VIP perks forever
                </div>
                <div className="w-full space-y-2 mb-6">
                  {["2x Daily Rewards", "2.5x Quest Rewards", "Withdrawal Access", "Exclusive VIP Quests", "Priority Support"].map(perk => (
                    <div key={perk} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#ff2d78]/30 bg-[#ff2d78]/5">
                      <CheckCircle size={12} className="text-[#ff2d78]" />
                      <span className="font-mono text-xs text-white">{perk}</span>
                    </div>
                  ))}
                </div>
                {!canAffordVip && (
                  <div className="flex items-center gap-2 mb-4 p-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10">
                    <AlertTriangle size={12} className="text-yellow-500" />
                    <span className="font-mono text-[10px] text-yellow-500">
                      Need {(VIP_FEE_POINTS - points).toLocaleString()} more points
                    </span>
                  </div>
                )}
                <button
                  onClick={handleVipUpgrade}
                  disabled={!canAffordVip || upgradeToVip.isPending}
                  className="w-full py-4 rounded-xl border-2 border-[#ff2d78] font-mono text-base font-black text-[#ff2d78] bg-[#ff2d78]/15 disabled:opacity-40"
                  style={{ boxShadow: canAffordVip ? "0 0 20px rgba(255,45,120,0.4)" : "none" }}
                  data-testid="btn-confirm-vip"
                >
                  {upgradeToVip.isPending ? "ACTIVATING..." : `PAY ${VIP_FEE_POINTS} AP`}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

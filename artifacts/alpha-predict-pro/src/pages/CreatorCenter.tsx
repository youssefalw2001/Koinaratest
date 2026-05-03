import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, Copy, Check, Share2, Users, TrendingUp, Star, Zap, MessageCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME || "KoinaraBot";

const CREATOR_RANKS = [
  { label: "Starter", min: 0, max: 2, commission: "20%" },
  { label: "Bronze", min: 3, max: 9, commission: "20%" },
  { label: "Silver", min: 10, max: 24, commission: "20%" },
  { label: "Gold", min: 25, max: 99, commission: "25%" },
  { label: "Elite", min: 100, max: Infinity, commission: "25%" },
];

function getRank(directCount: number) {
  return CREATOR_RANKS.find(r => directCount >= r.min && directCount <= r.max) ?? CREATOR_RANKS[0];
}

interface CrSummary {
  creatorCredits: number;
  totalCrEarned: number;
  creatorPassPaid: boolean;
  directReferralCount: number;
  indirectReferralCount: number;
  pendingCr: number;
}

export default function CreatorCenter() {
  const { user } = useTelegram();
  const [copied, setCopied] = useState(false);
  const [showCommissionBreakdown, setShowCommissionBreakdown] = useState(false);
  const [crSummary, setCrSummary] = useState<CrSummary | null>(null);

  const referralLink = user
    ? `https://t.me/${BOT_USERNAME}?start=${user.telegramId}`
    : "";

  const vip = user ? isVipActive(user) : false;
  const hasCreatorPass = user?.creatorPassPaid || vip;
  const directCount = crSummary?.directReferralCount ?? user?.directReferralCount ?? 0;
  const indirectCount = crSummary?.indirectReferralCount ?? 0;
  const crBalance = crSummary?.creatorCredits ?? user?.creatorCredits ?? 0;
  const totalCrEarned = crSummary?.totalCrEarned ?? user?.totalCrEarned ?? 0;
  const rank = getRank(directCount);

  const fetchCrSummary = useCallback(async () => {
    if (!user) return;
    try {
      const initData = window.Telegram?.WebApp?.initData ?? "";
      const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${apiBase}/api/creator/cr-summary/${user.telegramId}`, {
        headers: {
          "Content-Type": "application/json",
          ...(initData ? { "x-telegram-init-data": initData } : {}),
        },
      });
      if (res.ok) {
        const data = await res.json() as CrSummary;
        setCrSummary(data);
      }
    } catch {
      // Silently ignore — show user data as fallback
    }
  }, [user]);

  useEffect(() => {
    fetchCrSummary();
  }, [fetchCrSummary]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const shareText = `🚀 Join me on Koinara!\n\n💰 Trade BTC, play Mines, earn real USDT\n🎮 Battle other players and win Gold Coins\n📲 Everything inside Telegram — no app download\n\nMy referral link: ${referralLink}\n\nUse my link and we both earn when you play!`;

  const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;

  const whatsappShareUrl = `whatsapp://send?text=${encodeURIComponent(shareText)}`;

  const crToUsd = (cr: number) => (cr / 1000).toFixed(2);
  const crToAed = (cr: number) => ((cr / 1000) * 3.67).toFixed(2);

  if (!user) return null;

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">

      {/* Hero */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Crown size={16} className="text-[#00f0ff] drop-shadow-[0_0_8px_#00f0ff]" />
          <span className="font-mono text-xs text-white/60 tracking-[0.18em] uppercase">Creator Program</span>
        </div>
        <h1 className="text-2xl font-black text-white mb-0.5">Koinara Creator</h1>
        <p className="font-mono text-xs text-[#00f0ff]/70 mb-1">
          Apna link share karo, users lao, aur qualified sales se Creator Credits kamao.
        </p>
        <p className="font-mono text-[9px] text-white/30">
          Earnings are performance-based and reviewed. Not guaranteed income.
        </p>
      </div>

      {/* Creator Pass Status */}
      {hasCreatorPass ? (
        <div
          className="flex items-center gap-3 p-4 rounded-2xl border-2 border-[#00f0ff]/50 bg-[#00f0ff]/5 mb-4"
          style={{ boxShadow: "0 0 20px rgba(0,240,255,0.1)" }}
        >
          <div className="w-10 h-10 rounded-full flex items-center justify-center border border-[#00f0ff]/40 bg-[#00f0ff]/10">
            <Crown size={20} className="text-[#00f0ff]" />
          </div>
          <div className="flex-1">
            <div className="font-mono text-sm font-black text-[#00f0ff]">Creator Pass Active ✓</div>
            <div className="font-mono text-[10px] text-white/50">Rank: {rank.label} · {rank.commission} commission</div>
          </div>
          {rank.label !== "Starter" && (
            <div className="font-mono text-[9px] px-2 py-1 rounded-full border border-[#00f0ff]/30 text-[#00f0ff]">
              {rank.label}
            </div>
          )}
        </div>
      ) : (
        <div
          className="p-4 rounded-2xl border-2 border-[#FFD700]/40 bg-[#FFD700]/5 mb-4"
          style={{ boxShadow: "0 0 20px rgba(255,215,0,0.1)" }}
        >
          <div className="font-mono text-sm font-black text-[#FFD700] mb-1">Get Creator Pass</div>
          <div className="font-mono text-[11px] text-white/50 mb-2">
            $0.99 ≈ AED 3.63 ≈ 0.2 TON
          </div>
          <div className="font-mono text-[10px] text-white/40 mb-3">
            Earn 20% CR on every VIP purchase from your referrals.
            L2 network earns 5%.
          </div>
          <div className="font-mono text-[9px] text-white/30 italic">
            Stars payment coming soon. TON payment enabled.
          </div>
        </div>
      )}

      {/* CR Balance */}
      {hasCreatorPass && (
        <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
          <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-2">CR Balance</div>
          <div className="font-mono text-3xl font-black text-[#00f0ff] mb-1">
            {crBalance.toLocaleString()} CR
          </div>
          <div className="font-mono text-xs text-white/40">
            ≈ ${crToUsd(crBalance)} ≈ AED {crToAed(crBalance)}
          </div>
          {crSummary?.pendingCr !== undefined && crSummary.pendingCr > 0 && (
            <div className="font-mono text-[10px] text-[#FFD700]/60 mt-1">
              +{crSummary.pendingCr.toLocaleString()} CR pending (48h hold)
            </div>
          )}
          <div className="font-mono text-[10px] text-white/30 mt-1">
            Total earned: {totalCrEarned.toLocaleString()} CR ≈ ${crToUsd(totalCrEarned)} ≈ AED {crToAed(totalCrEarned)}
          </div>
        </div>
      )}

      {/* Earnings Table */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Estimated Earnings</div>
        {[
          { label: "1 friend buys VIP ($5.99/mo)", cr: 1198 },
          { label: "5 friends buy VIP", cr: 5990 },
          { label: "10 friends buy VIP", cr: 11980 },
        ].map(({ label, cr }) => (
          <div key={label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
            <span className="font-mono text-[10px] text-white/50">{label}</span>
            <div className="text-right">
              <div className="font-mono text-[10px] font-bold text-[#00f0ff]">{cr.toLocaleString()} CR</div>
              <div className="font-mono text-[9px] text-white/30">≈ ${crToUsd(cr)} ≈ AED {crToAed(cr)}</div>
            </div>
          </div>
        ))}
        <div className="font-mono text-[9px] text-white/25 mt-3">
          Estimates based on L1 20% commission on verified VIP purchases. Actual earnings depend
          on referral activity and platform review.
        </div>
      </div>

      {/* Referral Link */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Your Referral Link</div>
        <div className="flex items-center gap-2 p-2.5 rounded-xl bg-white/5 border border-white/10 mb-3">
          <span className="font-mono text-[10px] text-white/60 flex-1 truncate">{referralLink}</span>
        </div>
        <div className="flex gap-2 mb-2">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleCopyLink}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono text-xs font-bold border transition-all"
            style={{
              borderColor: copied ? "#00f0ff" : "rgba(255,255,255,0.15)",
              color: copied ? "#00f0ff" : "rgba(255,255,255,0.6)",
              background: copied ? "rgba(0,240,255,0.1)" : "rgba(255,255,255,0.03)",
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied!" : "Copy Link"}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => window.open(telegramShareUrl, "_blank")}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono text-xs font-bold border border-[#00f0ff]/30 text-[#00f0ff] bg-[#00f0ff]/8 transition-all"
          >
            <Share2 size={12} />
            Telegram
          </motion.button>
        </div>
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => window.open(whatsappShareUrl, "_blank")}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono text-xs font-bold border border-[#25D366]/30 text-[#25D366] bg-[#25D366]/8 transition-all"
        >
          <MessageCircle size={12} />
          Share on WhatsApp
        </motion.button>
      </div>

      {/* Network Stats */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Network Stats</div>
        {directCount === 0 && indirectCount === 0 ? (
          <div className="text-center py-4">
            <Users size={24} className="text-white/20 mx-auto mb-2" />
            <div className="font-mono text-xs text-white/30">Your first referral will appear here.</div>
            <div className="font-mono text-[10px] text-white/20">Share your link to get started.</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02] text-center">
              <div className="font-mono text-2xl font-black text-[#00f0ff]">{directCount}</div>
              <div className="font-mono text-[9px] text-white/40 mt-1">Direct (L1)</div>
            </div>
            <div className="p-3 rounded-xl border border-white/10 bg-white/[0.02] text-center">
              <div className="font-mono text-2xl font-black text-white/60">{indirectCount}</div>
              <div className="font-mono text-[9px] text-white/40 mt-1">Network (L2)</div>
            </div>
          </div>
        )}
      </div>

      {/* Commission Breakdown */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
        <button
          onClick={() => setShowCommissionBreakdown(v => !v)}
          className="flex items-center justify-between w-full"
        >
          <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase">Commission Structure</div>
          {showCommissionBreakdown ? <ChevronUp size={14} className="text-white/30" /> : <ChevronDown size={14} className="text-white/30" />}
        </button>
        <AnimatePresence>
          {showCommissionBreakdown && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-3 space-y-2">
                {[
                  { label: "L1 Direct", pct: "20%", cr: "1,198 CR", note: "per $5.99 VIP", aed: "AED 4.40" },
                  { label: "L2 Network", pct: "5%", cr: "299 CR", note: "per $5.99 VIP", aed: "AED 1.10" },
                  { label: "Renewals", pct: "20%", cr: "monthly", note: "recurring", aed: "" },
                  { label: "Gold/Elite Bonus", pct: "25%", cr: "+5%", note: "≥25 referrals", aed: "" },
                ].map(item => (
                  <div key={item.label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/[0.03]">
                    <div>
                      <div className="font-mono text-[10px] font-bold text-white/70">{item.label}</div>
                      <div className="font-mono text-[9px] text-white/30">{item.note}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[10px] font-bold text-[#00f0ff]">{item.pct} · {item.cr}</div>
                      {item.aed && <div className="font-mono text-[9px] text-white/30">{item.aed}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Creator Ranks */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/[0.02] mb-4">
        <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase mb-3">Creator Ranks</div>
        <div className="space-y-1.5">
          {CREATOR_RANKS.map(r => {
            const isActive = rank.label === r.label;
            return (
              <div
                key={r.label}
                className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-all ${
                  isActive
                    ? "border-[#00f0ff]/40 bg-[#00f0ff]/8 text-[#00f0ff]"
                    : "border-white/5 bg-white/[0.02] text-white/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isActive && <Star size={10} className="text-[#00f0ff]" />}
                  <span className="font-mono text-[10px] font-bold">{r.label}</span>
                  <span className="font-mono text-[9px] opacity-60">
                    {r.max === Infinity ? `${r.min}+` : `${r.min}-${r.max}`} referrals
                  </span>
                </div>
                <span className="font-mono text-[10px] font-bold">{r.commission}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Content Rewards Placeholder */}
      <div className="p-4 rounded-2xl border border-dashed border-white/10 bg-white/[0.01] mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Zap size={12} className="text-[#FFD700]/50" />
          <div className="font-mono text-[10px] text-white/40 tracking-widest uppercase">Content Rewards</div>
          <span className="font-mono text-[8px] px-1.5 py-0.5 rounded border border-white/10 text-white/30">Coming Soon</span>
        </div>
        <div className="font-mono text-[10px] text-white/30">
          Koinara content post karo aur submit karo. Approved content par Creator Credits mil sakte hain.
          Review ke baad hi reward milega — automatic nahi.
        </div>
      </div>

      {/* Quick stats footer */}
      <div className="font-mono text-[9px] text-white/20 text-center">
        CR = Creator Credits · $1 = 1,000 CR · 1 AED ≈ 272 CR
      </div>
    </div>
  );
}

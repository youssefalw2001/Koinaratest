import { Crown, Zap, Copy, Check } from "lucide-react";
import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import Earn from "./Earn";

const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME || "KoinaraBot";

export default function EarnCreatorLaunch() {
  const { user } = useTelegram();
  const [copied, setCopied] = useState(false);

  const vip = user ? isVipActive(user) : false;
  const hasCreatorPass = user?.creatorPassPaid || vip;
  const referralLink = user
    ? `https://t.me/${BOT_USERNAME}?start=${user.telegramId}`
    : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const crBalance = user?.creatorCredits ?? 0;
  const crToAed = (cr: number) => ((cr / 1000) * 3.67).toFixed(2);
  const directCount = user?.directReferralCount ?? 0;

  return (
    <div>
      {/* Creator Pass card — pinned at top of Earn page */}
      <div className="px-4 pt-4 pb-0">
        {hasCreatorPass ? (
          /* Active creator summary card */
          <div
            className="flex items-center justify-between p-3 rounded-2xl border border-[#00f0ff]/30 bg-[#00f0ff]/5 mb-3"
            style={{ boxShadow: "0 0 15px rgba(0,240,255,0.08)" }}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center border border-[#00f0ff]/30 bg-[#00f0ff]/10">
                <Crown size={16} className="text-[#00f0ff]" />
              </div>
              <div>
                <div className="font-mono text-[11px] font-black text-[#00f0ff]">Creator Pass Active ✓</div>
                <div className="font-mono text-[9px] text-white/40">
                  {crBalance.toLocaleString()} CR ≈ AED {crToAed(crBalance)} · {directCount} direct referrals
                </div>
              </div>
            </div>
            <Link href="/creator">
              <motion.button
                whileTap={{ scale: 0.96 }}
                className="font-mono text-[9px] font-bold px-2.5 py-1.5 rounded-lg border border-[#00f0ff]/30 text-[#00f0ff] bg-[#00f0ff]/10"
              >
                Open →
              </motion.button>
            </Link>
          </div>
        ) : (
          /* Creator Pass upsell card */
          <div
            className="p-4 rounded-2xl border-2 border-[#FFD700]/40 bg-[#FFD700]/5 mb-3"
            style={{ boxShadow: "0 0 20px rgba(255,215,0,0.1)" }}
          >
            <div className="flex items-start gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center border border-[#FFD700]/30 bg-[#FFD700]/10 shrink-0">
                <Crown size={18} className="text-[#FFD700]" />
              </div>
              <div>
                <div className="font-mono text-sm font-black text-[#FFD700]">Koinara Creator Pass</div>
                <div className="font-mono text-[10px] text-white/50">$0.99 ≈ AED 3.63 ≈ ₹82</div>
              </div>
            </div>
            <div className="space-y-1.5 mb-3">
              {[
                { label: "1 friend buys VIP ($5.99)", earn: "1,198 CR ≈ AED 4.40" },
                { label: "5 friends buy VIP", earn: "5,990 CR ≈ AED 22" },
                { label: "10 friends buy VIP", earn: "11,980 CR ≈ AED 44" },
              ].map(({ label, earn }) => (
                <div key={label} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-black/20">
                  <span className="font-mono text-[9px] text-white/50">{label}</span>
                  <span className="font-mono text-[9px] font-bold text-[#FFD700]">{earn}</span>
                </div>
              ))}
            </div>
            <div className="font-mono text-[8px] text-white/25 mb-3">
              Estimates based on L1 20% commission on verified VIP purchases. Not guaranteed.
            </div>
            <Link href="/creator">
              <motion.button
                whileTap={{ scale: 0.97 }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-mono text-sm font-black border-2 border-[#FFD700]/50 text-[#FFD700] bg-[#FFD700]/10 transition-all"
              >
                <Zap size={14} />
                Get Creator Pass →
              </motion.button>
            </Link>
          </div>
        )}

        {/* Quick referral link row (only for active creators) */}
        {hasCreatorPass && referralLink && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-white/5 border border-white/10 mb-3">
            <span className="font-mono text-[10px] text-white/40 flex-1 truncate">{referralLink}</span>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleCopy}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg font-mono text-[9px] font-bold border transition-all shrink-0"
              style={{
                borderColor: copied ? "#00f0ff" : "rgba(255,255,255,0.15)",
                color: copied ? "#00f0ff" : "rgba(255,255,255,0.4)",
              }}
            >
              {copied ? <Check size={10} /> : <Copy size={10} />}
              {copied ? "Copied!" : "Copy"}
            </motion.button>
          </div>
        )}
      </div>

      {/* Existing Earn page content below */}
      <Earn />
    </div>
  );
}

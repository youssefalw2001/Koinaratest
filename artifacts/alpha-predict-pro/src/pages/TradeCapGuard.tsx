import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Clock, ShieldCheck, ShoppingBag, Wallet, Zap } from "lucide-react";
import { Link } from "wouter";
import { useTelegram } from "@/lib/TelegramProvider";
import TerminalLaunch from "./TerminalLaunch";

const FREE_TRADE_CAP_GC = 7000;
const VIP_TRADE_CAP_GC = 20000;

function nextResetLabel(): string {
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0);
  const diff = Math.max(0, reset.getTime() - now.getTime());
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function TradeCapGuard() {
  const { user } = useTelegram();
  const [timer, setTimer] = useState(nextResetLabel());

  useEffect(() => {
    const id = window.setInterval(() => setTimer(nextResetLabel()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const cap = useMemo(() => (user?.isVip ? VIP_TRADE_CAP_GC : FREE_TRADE_CAP_GC), [user?.isVip]);
  const dailyEarned = user?.dailyGcEarned ?? 0;
  const capReached = dailyEarned >= cap;

  return (
    <div className="relative">
      <TerminalLaunch />
      {capReached && (
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          className="fixed inset-x-0 bottom-24 z-[86] mx-auto max-w-[396px] px-3 pointer-events-auto"
        >
          <div className="rounded-[28px] border border-[#FFD700]/35 bg-[#07090f]/95 p-4 shadow-[0_0_50px_rgba(255,215,0,.22)] backdrop-blur-2xl">
            <div className="flex items-start gap-3">
              <div className="h-13 w-13 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/12 flex items-center justify-center shadow-[0_0_22px_rgba(255,215,0,.18)]">
                <ShieldCheck size={24} className="text-[#FFD700]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[#FFD700]/85">Daily GC cap reached</div>
                <div className="text-xl font-black text-white mt-0.5">Trading cooldown active</div>
                <p className="font-mono text-[10px] text-white/45 mt-1 leading-relaxed">
                  You already earned {cap.toLocaleString()} GC from Trade today. Come back after reset so wins do not show +0 GC.
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 items-center">
              <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2">
                <div className="flex items-center gap-2 font-mono text-[10px] text-white/38"><Clock size={12} />Resets in</div>
                <div className="font-mono text-2xl font-black text-[#FFD700] tabular-nums">{timer}</div>
              </div>
              <Link href="/shop" className="rounded-2xl border border-[#4DA3FF]/30 bg-[#4DA3FF]/10 px-3 py-3 font-mono text-[10px] font-black text-[#8BC3FF] text-center">
                <ShoppingBag size={16} className="mx-auto mb-1" />Shop
              </Link>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Link href="/mines" className="rounded-2xl border border-[#00F5A0]/24 bg-[#00F5A0]/8 px-3 py-2 font-mono text-[10px] font-black text-[#00F5A0] flex items-center justify-center gap-1.5"><Zap size={12} />Play Mines</Link>
              <Link href="/wallet" className="rounded-2xl border border-[#FFD700]/24 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700] flex items-center justify-center gap-1.5"><Wallet size={12} />Wallet</Link>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}

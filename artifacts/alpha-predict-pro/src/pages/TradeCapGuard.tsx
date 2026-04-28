import { useEffect, useMemo, useState } from "react";
import { Clock, ShieldCheck, ShoppingBag, Zap } from "lucide-react";
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
        <div className="absolute left-3 right-3 top-[72px] z-[40] pointer-events-auto">
          <div className="rounded-2xl border border-[#FFD700]/28 bg-[#08101f]/92 px-3 py-2 shadow-[0_0_24px_rgba(255,215,0,.14)] backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/10 flex items-center justify-center shrink-0">
                <ShieldCheck size={16} className="text-[#FFD700]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-[#FFD700] truncate">Cap reached</div>
                  <div className="flex items-center gap-1 font-mono text-[10px] font-black text-[#FFD700] tabular-nums shrink-0">
                    <Clock size={11} /> {timer}
                  </div>
                </div>
                <div className="font-mono text-[9px] text-white/42 truncate">
                  Trade earning resumes after reset. Play Mines or open Shop meanwhile.
                </div>
              </div>
              <Link href="/mines" className="h-8 px-2 rounded-xl border border-[#00F5A0]/24 bg-[#00F5A0]/8 font-mono text-[9px] font-black text-[#00F5A0] flex items-center gap-1 shrink-0">
                <Zap size={11} /> Mines
              </Link>
              <Link href="/shop" className="h-8 px-2 rounded-xl border border-[#4DA3FF]/24 bg-[#4DA3FF]/8 font-mono text-[9px] font-black text-[#8BC3FF] flex items-center gap-1 shrink-0">
                <ShoppingBag size={11} /> Shop
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

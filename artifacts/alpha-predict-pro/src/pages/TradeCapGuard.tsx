import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
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
        <div className="absolute left-[104px] right-[24px] top-[58px] z-[40] pointer-events-none">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="font-mono text-[7px] font-black tracking-[0.18em] uppercase text-[#FFD700]/70">
              Cap reached
            </span>
            <span className="flex items-center gap-1 font-mono text-[7px] font-black text-white/38 tabular-nums">
              <Clock size={8} className="text-[#FFD700]/55" />
              Reset {timer}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

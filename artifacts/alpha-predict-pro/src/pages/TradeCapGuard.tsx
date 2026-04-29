import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Clock, Sparkles, Zap } from "lucide-react";
import TerminalLaunch from "./TerminalLaunch";
import { useTelegram } from "@/lib/TelegramProvider";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;

type TradeCapStatus = {
  baseCap: number;
  boostGc: number;
  effectiveCap: number;
  earnedToday: number;
  remaining: number;
  capReached: boolean;
  resetAt: string;
  resetTimeStandard: string;
};

function formatCountdown(resetAt?: string): string {
  if (!resetAt) return "--:--";
  const diff = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return "00:00";
  const totalMinutes = Math.ceil(diff / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export default function TradeCapGuard() {
  const { user } = useTelegram();
  const [cap, setCap] = useState<TradeCapStatus | null>(null);
  const [tick, setTick] = useState(0);
  const initData = (window as any)?.Telegram?.WebApp?.initData ?? "";

  useEffect(() => {
    if (!user?.telegramId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/trade-cap/${encodeURIComponent(user.telegramId)}`, {
          headers: initData ? { "x-telegram-init-data": initData } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setCap(data);
      } catch {
        // Keep trading UI usable even if cap status endpoint is unavailable.
      }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.telegramId, initData]);

  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const countdown = useMemo(() => formatCountdown(cap?.resetAt), [cap?.resetAt, tick]);
  const showOvertimeCta = !!cap?.capReached && cap.boostGc <= 0;

  return (
    <div className="relative">
      {showOvertimeCta && (
        <div className="mx-3 mb-2 rounded-3xl border border-[#FFD700]/35 bg-[#FFD700]/10 p-3 shadow-[0_0_26px_rgba(255,215,0,.14)]">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/12 flex items-center justify-center shrink-0">
              <Zap size={18} className="text-[#FFD700]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="font-black text-[#FFD700]">Daily Trade cap reached</div>
                <div className="font-mono text-[10px] text-white/45 flex items-center gap-1 shrink-0"><Clock size={11} />{countdown}</div>
              </div>
              <p className="font-mono text-[10px] leading-relaxed text-white/45 mt-1">
                You earned {cap.earnedToday.toLocaleString()} / {cap.effectiveCap.toLocaleString()} GC today. Unlock +3,000 more Trade earning room until reset.
              </p>
              <Link href="/exchange" className="mt-2 h-10 rounded-2xl border border-[#FFD700]/35 bg-[#FFD700]/12 text-[#FFD700] font-black flex items-center justify-center gap-2">
                <Sparkles size={14} /> Unlock Overtime Pass
              </Link>
            </div>
          </div>
        </div>
      )}
      <TerminalLaunch />
    </div>
  );
}

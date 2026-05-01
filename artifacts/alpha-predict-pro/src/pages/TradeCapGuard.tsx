import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import TerminalLaunch from "./TerminalTradeHotfix";
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

function resetDiffMs(resetAt?: string): number {
  if (!resetAt) return Number.POSITIVE_INFINITY;
  const diff = new Date(resetAt).getTime() - Date.now();
  return Number.isFinite(diff) ? diff : Number.POSITIVE_INFINITY;
}

export default function TradeCapGuard() {
  const { user, refreshUser } = useTelegram();
  const [cap, setCap] = useState<TradeCapStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshingCap, setRefreshingCap] = useState(false);
  const lastResetRefreshRef = useRef<string | null>(null);
  const initData = (window as any)?.Telegram?.WebApp?.initData ?? "";

  const loadCap = useCallback(async () => {
    if (!user?.telegramId) return;
    setRefreshingCap(true);
    try {
      const res = await fetch(`${API_BASE}/trade-cap/${encodeURIComponent(user.telegramId)}?ts=${Date.now()}`, {
        cache: "no-store",
        headers: initData ? { "x-telegram-init-data": initData, "Cache-Control": "no-cache" } : { "Cache-Control": "no-cache" },
      });
      if (!res.ok) return;
      const data = await res.json();
      setCap(data);
    } catch {
      // Keep trading UI usable even if cap status endpoint is unavailable.
    } finally {
      setRefreshingCap(false);
    }
  }, [user?.telegramId, initData]);

  useEffect(() => {
    loadCap();
    const interval = setInterval(loadCap, 10_000);
    return () => clearInterval(interval);
  }, [loadCap]);

  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!cap?.resetAt) return;
    const diff = resetDiffMs(cap.resetAt);
    if (diff <= 0 && lastResetRefreshRef.current !== cap.resetAt) {
      lastResetRefreshRef.current = cap.resetAt;
      void refreshUser();
      void loadCap();
      window.setTimeout(loadCap, 1500);
      window.setTimeout(loadCap, 4000);
    }
  }, [cap?.resetAt, tick, loadCap, refreshUser]);

  const resetHasPassed = cap ? resetDiffMs(cap.resetAt) <= 0 : false;
  const showResetRefresh = !!cap?.capReached && resetHasPassed;

  return (
    <div className="relative">
      {showResetRefresh && (
        <div className="mx-3 mb-2 rounded-3xl border border-[#4DA3FF]/30 bg-[#4DA3FF]/10 p-3 shadow-[0_0_22px_rgba(77,163,255,.12)]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl border border-[#4DA3FF]/30 bg-[#4DA3FF]/12 flex items-center justify-center shrink-0">
              <RefreshCw size={17} className={`text-[#8BC3FF] ${refreshingCap ? "animate-spin" : ""}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-black text-[#8BC3FF]">Refreshing daily cap</div>
              <p className="font-mono text-[10px] leading-relaxed text-white/45 mt-1">The reset time passed. Pulling fresh cap data now.</p>
            </div>
            <button onClick={loadCap} className="rounded-2xl border border-[#4DA3FF]/30 bg-[#4DA3FF]/10 px-3 py-2 font-mono text-[10px] font-black text-[#8BC3FF]">Refresh</button>
          </div>
        </div>
      )}
      <TerminalLaunch tradeCap={cap} onTradeResolved={loadCap} />
    </div>
  );
}

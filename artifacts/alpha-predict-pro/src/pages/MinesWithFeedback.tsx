import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bomb, Eye, Gem, Trophy, TrendingUp } from "lucide-react";
import Mines from "./Mines";
import { useTelegram } from "@/lib/TelegramProvider";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;

type RecentMineBet = {
  id: string;
  won: boolean;
  amount: number;
  currency: string;
  multiplier?: number;
  at: number;
};

type ActiveRoundLite = {
  roundId: number;
  revealed: number[];
  minesCount: number;
  tier?: string | null;
  activeGems?: { safe_reveal_used?: boolean };
};

const STORAGE_KEY_PREFIX = "koinara_recent_mines_v1";

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function currencyForResult(data: any, isCashout: boolean): string {
  if (isCashout) {
    if (pickNumber(data?.gcPayout, data?.goldCoinsAwarded, data?.goldCoins, data?.payout) !== null) return "GC";
    if (pickNumber(data?.tcPayout, data?.tradeCreditsAwarded, data?.tradeCredits) !== null) return "TC";
  }
  if (data?.mode === "gc" && data?.tier !== "gold") return "GC";
  if (data?.currency === "gc" || data?.betCurrency === "gc") return "GC";
  return "TC";
}

function amountForCashout(data: any): number {
  return pickNumber(
    data?.gcPayout,
    data?.tcPayout,
    data?.payout,
    data?.goldCoinsAwarded,
    data?.tradeCreditsAwarded,
    data?.reward,
    data?.cashoutValue,
  ) ?? 0;
}

function amountForBust(data: any): number {
  return pickNumber(
    data?.bet,
    data?.stake,
    data?.amount,
    data?.lostAmount,
    data?.round?.bet,
    data?.activeRound?.bet,
    data?.refund,
  ) ?? 0;
}

function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export default function MinesWithFeedback() {
  const { user } = useTelegram();
  const storageKey = `${STORAGE_KEY_PREFIX}:${user?.telegramId ?? "guest"}`;
  const [recent, setRecent] = useState<RecentMineBet[]>([]);
  const [winToast, setWinToast] = useState<RecentMineBet | null>(null);
  const [activeRound, setActiveRound] = useState<ActiveRoundLite | null>(null);
  const [safeRevealBusy, setSafeRevealBusy] = useState(false);
  const [safeRevealMessage, setSafeRevealMessage] = useState<string | null>(null);
  const initData = (window as any)?.Telegram?.WebApp?.initData ?? "";

  const loadActiveRound = async () => {
    if (!user?.telegramId) return;
    try {
      const res = await fetch(`${API_BASE}/mines/active/${encodeURIComponent(user.telegramId)}`, {
        headers: initData ? { "x-telegram-init-data": initData } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      setActiveRound(data?.active ?? null);
    } catch {}
  };

  useEffect(() => {
    loadActiveRound();
    const interval = setInterval(loadActiveRound, 5000);
    return () => clearInterval(interval);
  }, [user?.telegramId, initData]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "[]") as RecentMineBet[];
      setRecent(Array.isArray(saved) ? saved.slice(0, 5) : []);
    } catch {
      setRecent([]);
    }
  }, [storageKey]);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const isMinesCashout = url.includes("/api/mines/cashout");
      const isMinesReveal = url.includes("/api/mines/reveal");
      const isMinesStart = url.includes("/api/mines/start");

      if (isMinesStart || isMinesReveal || isMinesCashout) {
        window.setTimeout(loadActiveRound, 350);
      }

      if (!isMinesCashout && !isMinesReveal) return response;

      try {
        const clone = response.clone();
        const data = await clone.json();
        if (!response.ok) return response;

        const isBust = isMinesReveal && data?.hit === true && data?.shielded !== true;
        const won = isMinesCashout || data?.secondChance === true;
        if (!isMinesCashout && !isBust) return response;

        const item: RecentMineBet = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          won,
          amount: won ? amountForCashout(data) : amountForBust(data),
          currency: currencyForResult(data, isMinesCashout),
          multiplier: pickNumber(data?.multiplier) ?? undefined,
          at: Date.now(),
        };

        setRecent((prev) => {
          const next = [item, ...prev].slice(0, 5);
          localStorage.setItem(storageKey, JSON.stringify(next));
          return next;
        });
        if (won && item.amount > 0) {
          setWinToast(item);
          window.setTimeout(() => setWinToast(null), 2800);
        }
      } catch {
        // Leave game flow untouched if parsing fails.
      }
      return response;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, [storageKey, user?.telegramId]);

  const handleSafeReveal = async () => {
    if (!user?.telegramId || !activeRound || safeRevealBusy) return;
    setSafeRevealBusy(true);
    setSafeRevealMessage(null);
    try {
      const res = await fetch(`${API_BASE}/mines/safe-reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(initData ? { "x-telegram-init-data": initData } : {}) },
        body: JSON.stringify({ telegramId: user.telegramId, roundId: activeRound.roundId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Safe Reveal failed.");
      setSafeRevealMessage(data?.message ?? "Safe Reveal activated.");
      await loadActiveRound();
      window.setTimeout(() => window.location.reload(), 450);
    } catch (err) {
      setSafeRevealMessage(err instanceof Error ? err.message : "Safe Reveal failed.");
    } finally {
      setSafeRevealBusy(false);
      window.setTimeout(() => setSafeRevealMessage(null), 3500);
    }
  };

  const visibleRecent = useMemo(() => recent.slice(0, 5), [recent]);
  const revealedCount = activeRound?.revealed?.length ?? 0;
  const safeRevealLockedReason = !activeRound
    ? null
    : activeRound.tier === "gold"
      ? "Disabled on Gold mode"
      : activeRound.minesCount > 10
        ? "Unavailable above 10 bombs"
        : activeRound.activeGems?.safe_reveal_used
          ? "Used this round"
          : revealedCount < 3
            ? `Unlocks after ${3 - revealedCount} more safe tile${3 - revealedCount === 1 ? "" : "s"}`
            : null;

  return (
    <div className="relative">
      <Mines />

      {activeRound && (
        <section className="mx-4 -mt-2 mb-3 rounded-3xl border border-[#00BFFF]/22 bg-[#00BFFF]/8 p-3 shadow-[0_0_26px_rgba(0,191,255,.10)] relative z-20">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl border border-[#00BFFF]/30 bg-[#00BFFF]/12 flex items-center justify-center shrink-0"><Eye size={18} className="text-[#00BFFF]" /></div>
            <div className="flex-1 min-w-0">
              <div className="font-black text-[#00BFFF]">Safe Reveal</div>
              <div className="font-mono text-[10px] text-white/42">Reveals 1 safe tile after you survive 3 tiles. Consumed immediately.</div>
              {safeRevealMessage && <div className="mt-1 font-mono text-[10px] text-[#FFD700]">{safeRevealMessage}</div>}
            </div>
            <button onClick={handleSafeReveal} disabled={!!safeRevealLockedReason || safeRevealBusy} className="rounded-2xl border border-[#00BFFF]/35 bg-[#00BFFF]/10 px-3 py-2 font-mono text-[10px] font-black text-[#00BFFF] disabled:opacity-40">
              {safeRevealBusy ? "Using" : safeRevealLockedReason ?? "Activate"}
            </button>
          </div>
        </section>
      )}

      <AnimatePresence>
        {winToast && (
          <motion.div
            initial={{ opacity: 0, y: -18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 0.96 }}
            className="fixed left-4 right-4 top-[108px] z-[85] mx-auto max-w-[390px] rounded-3xl border border-[#FFD700]/35 bg-[#08090f]/95 p-4 shadow-[0_0_42px_rgba(255,215,0,.22)] backdrop-blur-xl"
          >
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-[#FFD700]/14 border border-[#FFD700]/35 flex items-center justify-center">
                <Trophy size={24} className="text-[#FFD700] drop-shadow-[0_0_12px_rgba(255,215,0,.65)]" />
              </div>
              <div>
                <div className="font-mono text-[10px] text-white/42 tracking-[0.2em] uppercase">Mines Cashout</div>
                <div className="text-2xl font-black text-[#FFD700]">+{winToast.amount.toLocaleString()} {winToast.currency}</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {visibleRecent.length > 0 && (
        <section className="mx-4 -mt-20 mb-28 rounded-3xl border border-[#FFD700]/16 bg-[#090b12]/88 p-3 shadow-[0_0_34px_rgba(0,0,0,.36)] backdrop-blur-xl relative z-20">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-white/42">Past 5 Mines Bets</div>
            <Gem size={14} className="text-[#FFD700]" />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {visibleRecent.map((item) => (
              <div key={item.id} className="min-w-[118px] rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center ${item.won ? "bg-[#FFD700]/13" : "bg-[#FF1744]/13"}`}>
                    {item.won ? <TrendingUp size={15} className="text-[#FFD700]" /> : <Bomb size={15} className="text-[#FF1744]" />}
                  </div>
                  <div className={`font-black text-xs ${item.won ? "text-[#FFD700]" : "text-[#FF1744]"}`}>{item.won ? "WIN" : "BUST"}</div>
                </div>
                <div className="font-mono text-sm font-black text-white">{item.won ? "+" : "-"}{item.amount.toLocaleString()} {item.currency}</div>
                {item.multiplier && <div className="font-mono text-[9px] text-[#FFD700]/60 mt-1">at {item.multiplier.toFixed(2)}×</div>}
                <div className="font-mono text-[9px] text-white/28 mt-1">{timeAgo(item.at)} ago</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

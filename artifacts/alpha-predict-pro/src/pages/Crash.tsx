import { useCallback, useEffect, useMemo, useState } from "react";
import { Rocket, TrendingUp, Clock3, ShieldAlert } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useLanguage } from "@/lib/language";

type CrashRoundState = {
  id: number;
  phase: "betting" | "running" | "crashed";
  bettingOpensAt: string;
  bettingClosesAt: string;
  runningStartedAt: string;
  crashAt: string;
  crashMultiplier: number;
  seedHash: string;
  revealedSeed: string | null;
};

type CrashStateResponse = {
  houseEdge: number;
  cycleMs: number;
  round: CrashRoundState;
  live: {
    elapsedSec: number;
    multiplier: number;
    crashed: boolean;
  };
};

type CrashHistoryRow = {
  id: number;
  phase: "betting" | "running" | "crashed";
  crashMultiplier: number;
  createdAt: string;
  runningStartedAt: string;
  bettingClosesAt: string;
  crashAt: string;
};

type CrashBetRow = {
  id: number;
  roundId: number;
  telegramId: string;
  amountTc: number;
  status: "pending" | "cashed" | "lost";
  cashoutMultiplier: number | null;
  payoutGc: number;
  createdAt: string;
  resolvedAt: string | null;
  crashMultiplier: number | null;
};

const BET_OPTIONS = [25, 50, 100, 250, 500, 1000];

function secondsLeft(targetIso: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(targetIso).getTime() - Date.now()) / 1000),
  );
}

function apiUrl(path: string): string {
  const base =
    (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ??
    "";
  return `${base}${path}`;
}

function getTelegramAuthHeaders(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData?.trim();
  return initData ? { "x-telegram-init-data": initData } : {};
}

export default function Crash() {
  const { user, refreshUser } = useTelegram();
  const { t } = useLanguage();

  const [state, setState] = useState<CrashStateResponse | null>(null);
  const [history, setHistory] = useState<CrashHistoryRow[]>([]);
  const [myBets, setMyBets] = useState<CrashBetRow[]>([]);
  const [selectedBet, setSelectedBet] = useState<number>(100);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [stateRes, historyRes, betsRes] = await Promise.all([
        fetch(apiUrl("/api/crash/state")),
        fetch(apiUrl("/api/crash/history?limit=10")),
        user
          ? fetch(
              apiUrl(
                `/api/crash/bets/${encodeURIComponent(user.telegramId)}?limit=10`,
              ),
            )
          : Promise.resolve(null),
      ]);

      if (!stateRes.ok) {
        throw new Error("Unable to load crash state.");
      }

      const stateJson = (await stateRes.json()) as CrashStateResponse;
      setState(stateJson);

      if (historyRes.ok) {
        setHistory((await historyRes.json()) as CrashHistoryRow[]);
      }

      if (betsRes && betsRes.ok) {
        setMyBets((await betsRes.json()) as CrashBetRow[]);
      }

      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load crash data.",
      );
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadData();
    const id = setInterval(() => {
      void loadData();
    }, 1000);
    return () => clearInterval(id);
  }, [loadData]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const liveMultiplier = state?.live.multiplier ?? 1;
  const currentRoundId = state?.round.id ?? null;
  const activeMyBet = useMemo(
    () =>
      myBets.find(
        (bet) => bet.roundId === currentRoundId && bet.status === "pending",
      ) ?? null,
    [myBets, currentRoundId],
  );

  const bettingOpen =
    !!state &&
    !state.live.crashed &&
    secondsLeft(state.round.bettingClosesAt) > 0;
  const runningNow =
    !!state &&
    !state.live.crashed &&
    secondsLeft(state.round.bettingClosesAt) === 0 &&
    secondsLeft(state.round.crashAt) > 0;
  const canCashout = !!activeMyBet && runningNow;

  const handleBet = async () => {
    if (!user || !state || !bettingOpen || busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/crash/bet"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getTelegramAuthHeaders(),
        },
        body: JSON.stringify({
          telegramId: user.telegramId,
          amountTc: selectedBet,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(String(payload?.error ?? "Failed to place bet."));
      }
      setNotice(`Bet placed: ${selectedBet} TC`);
      refreshUser();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place bet.");
    } finally {
      setBusy(false);
    }
  };

  const handleCashout = async () => {
    if (!user || !state || !canCashout || busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/crash/cashout"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getTelegramAuthHeaders(),
        },
        body: JSON.stringify({
          telegramId: user.telegramId,
          roundId: state.round.id,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(String(payload?.error ?? "Cashout failed."));
      }
      setNotice(
        `Cashed out @ ${payload.cashoutMultiplier}x → +${payload.payoutGc} GC`,
      );
      refreshUser();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cashout failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="px-4 pt-4 pb-8">
        <div className="app-card p-4 font-mono text-sm text-white/50">
          Loading crash arena...
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-3">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Rocket size={16} className="text-[#FFD700]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">
            {t("crash")} Arena
          </span>
          <span className="ml-auto font-mono text-[10px] text-[#FFD700]/80">
            House Edge {(state?.houseEdge ?? 0.12) * 100}%
          </span>
        </div>
        <div className="text-center py-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/5">
          <div className="font-mono text-[10px] text-white/40 tracking-[0.12em] uppercase mb-1">
            Live Multiplier
          </div>
          <div
            className={`font-mono text-4xl font-black ${
              state?.live.crashed ? "text-[#FF1744]" : "text-[#00E676]"
            }`}
          >
            {liveMultiplier.toFixed(2)}x
          </div>
          <div className="mt-2 font-mono text-[10px] text-white/45">
            {bettingOpen && state
              ? `Betting closes in ${secondsLeft(state.round.bettingClosesAt)}s`
              : null}
            {runningNow && state
              ? `Crashes in ${secondsLeft(state.round.crashAt)}s`
              : null}
            {state?.live.crashed
              ? `Round crashed at ${state.round.crashMultiplier.toFixed(2)}x`
              : null}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/10 px-3 py-2 flex items-center gap-2">
          <ShieldAlert size={14} className="text-[#FF1744] shrink-0" />
          <span className="font-mono text-xs text-[#ffb3c2]">{error}</span>
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-[#00E676]/25 bg-[#00E676]/10 px-3 py-2">
          <span className="font-mono text-xs text-[#9cffca]">{notice}</span>
        </div>
      )}

      <div className="app-card p-4">
        <div className="font-mono text-[10px] text-white/40 tracking-[0.14em] uppercase mb-2">
          Bet Amount (TC)
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {BET_OPTIONS.map((value) => (
            <button
              key={value}
              className={`pressable rounded-full py-2 font-mono text-xs border ${
                selectedBet === value
                  ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF]"
                  : "border-white/10 text-white/50"
              }`}
              onClick={() => setSelectedBet(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleBet}
            type="button"
            disabled={
              !user ||
              !bettingOpen ||
              busy ||
              !!activeMyBet ||
              selectedBet > (user?.tradeCredits ?? 0)
            }
            className="pressable rounded-xl py-3 font-mono text-xs font-bold border border-[#4DA3FF]/40 bg-[#4DA3FF]/15 text-[#8BC3FF] disabled:opacity-35"
          >
            Place Bet
          </button>
          <button
            onClick={handleCashout}
            type="button"
            disabled={!canCashout || busy}
            className="pressable rounded-xl py-3 font-mono text-xs font-bold border border-[#00E676]/40 bg-[#00E676]/15 text-[#91ffca] disabled:opacity-35"
          >
            Cashout Now
          </button>
        </div>

        {!user && (
          <div className="mt-2 font-mono text-[10px] text-[#FFD700]/75">
            Sign in with Telegram to place crash bets.
          </div>
        )}
        {activeMyBet && (
          <div className="mt-2 font-mono text-[10px] text-white/60">
            Active bet: {activeMyBet.amountTc} TC ({activeMyBet.status})
          </div>
        )}
      </div>

      <div className="app-card p-4">
        <div className="flex items-center gap-1.5 mb-2">
          <Clock3 size={13} className="text-white/55" />
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/45">
            Recent Crash Rounds
          </span>
        </div>
        <div className="space-y-2">
          {history.map((row) => (
            <div
              key={row.id}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 flex items-center"
            >
              <span className="font-mono text-[10px] text-white/45">
                #{row.id}
              </span>
              <span className="ml-2 font-mono text-xs text-[#FFD700]">
                {row.crashMultiplier.toFixed(2)}x
              </span>
              <span
                className={`ml-auto font-mono text-[10px] ${
                  row.phase === "crashed" ? "text-[#FF1744]" : "text-[#00E676]"
                }`}
              >
                {row.phase.toUpperCase()}
              </span>
            </div>
          ))}
          {!history.length && (
            <div className="font-mono text-xs text-white/30">
              No rounds yet.
            </div>
          )}
        </div>
      </div>

      <div className="app-card p-4">
        <div className="flex items-center gap-1.5 mb-2">
          <TrendingUp size={13} className="text-white/55" />
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/45">
            My Crash Bets
          </span>
        </div>
        <div className="space-y-2">
          {myBets.map((bet) => (
            <div
              key={bet.id}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2"
            >
              <div className="flex items-center">
                <span className="font-mono text-[10px] text-white/45">
                  Round #{bet.roundId}
                </span>
                <span className="ml-auto font-mono text-[10px] text-white/45">
                  {bet.amountTc} TC
                </span>
              </div>
              <div className="mt-1 flex items-center">
                <span
                  className={`font-mono text-[10px] ${
                    bet.status === "cashed"
                      ? "text-[#00E676]"
                      : bet.status === "lost"
                        ? "text-[#FF1744]"
                        : "text-[#FFD700]"
                  }`}
                >
                  {bet.status}
                </span>
                <span className="ml-auto font-mono text-[10px] text-white/65">
                  {bet.status === "cashed"
                    ? `+${bet.payoutGc} GC @ ${bet.cashoutMultiplier ?? 1}x`
                    : null}
                  {bet.status === "lost"
                    ? `Crashed @ ${bet.crashMultiplier ?? "?"}x`
                    : null}
                  {bet.status === "pending" ? "In play..." : null}
                </span>
              </div>
            </div>
          ))}
          {!myBets.length && (
            <div className="font-mono text-xs text-white/30">
              No crash bets yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

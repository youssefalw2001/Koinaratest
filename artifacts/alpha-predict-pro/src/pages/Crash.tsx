import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Rocket, TrendingUp, Clock3, ShieldAlert } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useLanguage } from "@/lib/language";

type CrashRoundState = {
  id: number;
  status?: "active" | "crashed" | "betting" | "running" | "settled";
  phase?: "betting" | "running" | "crashed" | "settled";
  startedAt?: string;
  bettingOpensAt: string;
  bettingClosesAt: string;
  settlesAt?: string;
  settledAt?: string | null;
  runningStartedAt?: string;
  crashAt?: string;
  crashMultiplier: number;
  seedHash: string;
  revealedSeed: string | null;
};

type CrashStateResponse = {
  houseEdge: number;
  cycleMs: number;
  serverTimeMs?: number;
  round: CrashRoundState;
  live: {
    elapsedSec: number;
    multiplier: number;
    crashed: boolean;
  };
};

type CrashHistoryRow = {
  id: number;
  status?: "active" | "crashed" | "betting" | "running" | "settled";
  phase?: "betting" | "running" | "crashed" | "settled";
  crashMultiplier: number;
  createdAt?: string;
  startedAt?: string;
  bettingClosesAt?: string;
  settlesAt?: string;
};

type CrashBetRow = {
  id: number;
  roundId: number;
  telegramId: string;
  amountTc: number;
  status: "pending" | "active" | "cashed" | "cashed_out" | "lost";
  cashoutAt?: number | null;
  cashoutMultiplier?: number | null;
  payoutGc: number;
  createdAt: string;
  resolvedAt: string | null;
  crashMultiplier: number | null;
};

const BET_OPTIONS = [25, 50, 100, 250, 500, 1000];
const CASHOUT_IDEMPOTENCY_KEY = "crash-cashout";

function secondsLeft(targetIso: string): number {
  return Math.max(0, Math.ceil((new Date(targetIso).getTime() - Date.now()) / 1000));
}

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

function makeIdempotencyKey(prefix: string, parts: Array<string | number>): string {
  return `${prefix}:${parts.map((entry) => String(entry)).join(":")}`;
}

function normalizeRound(raw: CrashStateResponse["round"]): CrashStateResponse["round"] {
  const startedAt =
    raw.startedAt ??
    raw.bettingOpensAt ??
    raw.runningStartedAt ??
    new Date().toISOString();
  const settlesAt =
    raw.settlesAt ??
    raw.crashAt ??
    new Date(Date.now() + 10_000).toISOString();
  const status = raw.status ?? raw.phase ?? "betting";

  return {
    ...raw,
    status,
    startedAt,
    settlesAt,
  };
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
  const [cashoutPending, setCashoutPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comingSoon, setComingSoon] = useState(false);

  const applyStatePayload = useCallback((stateJson: CrashStateResponse) => {
    setState({ ...stateJson, round: normalizeRound(stateJson.round) });
  }, []);

  const loadData = useCallback(async () => {
    const telegramInitData = window.Telegram?.WebApp?.initData;
    try {
      const [stateRes, historyRes, betsRes] = await Promise.all([
        fetch(apiUrl("/api/crash/state"), {
          headers: telegramInitData ? { "X-Telegram-Init-Data": telegramInitData } : undefined,
        }),
        fetch(apiUrl("/api/crash/history?limit=10")),
        user
          ? fetch(apiUrl(`/api/crash/bets/${encodeURIComponent(user.telegramId)}?limit=10`), {
              headers: telegramInitData ? { "X-Telegram-Init-Data": telegramInitData } : undefined,
            })
          : Promise.resolve(null),
      ]);

      if (!stateRes.ok) {
        const body = await stateRes.text();
        throw new Error(body || `Unable to load crash state (${stateRes.status}).`);
      }

      const stateJson = (await stateRes.json()) as CrashStateResponse;
      applyStatePayload(stateJson);

      if (historyRes.ok) {
        const historyJson = (await historyRes.json()) as CrashHistoryRow[];
        setHistory(
          historyJson.map((row) => ({
            ...row,
            status: row.status ?? row.phase ?? "crashed",
          })),
        );
      }

      if (betsRes && betsRes.ok) {
        setMyBets((await betsRes.json()) as CrashBetRow[]);
      }

      setError(null);
    } catch (err) {
      setComingSoon(true);
      setError(err instanceof Error ? err.message : "Failed to load crash data.");
    } finally {
      setLoading(false);
    }
  }, [applyStatePayload, user]);

  useEffect(() => {
    void loadData();
    const streamUrl = `${apiUrl("/api/crash/stream")}${user ? `?telegramId=${encodeURIComponent(user.telegramId)}` : ""}`;
    const eventSource = new EventSource(streamUrl);
    let streamActive = false;

    eventSource.onopen = () => {
      streamActive = true;
      setError(null);
    };
    eventSource.addEventListener("state", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as CrashStateResponse;
        applyStatePayload(payload);
      } catch {
        // Ignore malformed stream chunk and keep stream alive.
      } finally {
        setLoading(false);
      }
    });
    eventSource.onerror = () => {
      streamActive = false;
      setComingSoon(true);
    };

    const fallbackPoll = setInterval(() => {
      if (!streamActive) {
        void loadData();
      }
    }, 2500);

    return () => {
      clearInterval(fallbackPoll);
      eventSource.close();
    };
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
        (bet) => bet.roundId === currentRoundId && (bet.status === "pending" || bet.status === "active"),
      ) ?? null,
    [myBets, currentRoundId],
  );

  const bettingOpen = !!state && state.round.phase === "betting";
  const runningNow = !!state && state.round.phase === "running";
  const canCashout = !!activeMyBet && runningNow && !state?.live.crashed && !cashoutPending;

  const remainingDailyGc = useMemo(() => {
    if (!user) return null;
    const cap = user.isVip ? 6000 : 800;
    return Math.max(0, cap - (user.dailyGcEarned ?? 0));
  }, [user]);

  const handleBet = async () => {
    if (!user || !state || !bettingOpen || busy) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/crash/bet"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(window.Telegram?.WebApp?.initData
            ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
            : {}),
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
    if (!user || !state || !canCashout || busy || cashoutPending) return;
    setBusy(true);
    setCashoutPending(true);
    try {
      const idempotencyKey = makeIdempotencyKey(CASHOUT_IDEMPOTENCY_KEY, [
        user.telegramId,
        state.round.id,
      ]);
      const res = await fetch(apiUrl("/api/crash/cashout"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(window.Telegram?.WebApp?.initData
            ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
            : {}),
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
      if (payload?.alreadyResolved) {
        setNotice("Cashout already resolved.");
      } else {
        setNotice(`Cashed out @ ${payload.cashoutMultiplier}x → +${payload.payoutGc} GC`);
      }
      refreshUser();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cashout failed.");
    } finally {
      setCashoutPending(false);
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="px-4 pt-4 pb-8">
        <div className="app-card p-4 font-mono text-sm text-white/50">Loading crash arena...</div>
      </div>
    );
  }

  if (comingSoon || !state) {
    return (
      <div className="px-4 pt-4 pb-8">
        <div className="app-card p-5 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/5">
          <div className="flex items-center gap-2 mb-2">
            <Rocket size={16} className="text-[#FFD700]" />
            <span className="font-mono text-xs text-[#FFD700] tracking-[0.16em] uppercase">Crash Arena</span>
          </div>
          <div className="font-mono text-lg font-black text-white mb-1">Coming Soon</div>
          <div className="font-mono text-xs text-white/50">
            We are hardening Crash for maximum fairness and reliability.
            Lootbox and Digital Arbitrage are live now in the navigation.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-3">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Rocket size={16} className="text-[#FFD700]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">{t("crash")} Arena</span>
          <span className="ml-auto font-mono text-[10px] text-[#FFD700]/80">
            House Edge {(state?.houseEdge ?? 0.12) * 100}%
          </span>
        </div>
        <div className="text-center py-3 rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/5">
          <div className="font-mono text-[10px] text-white/40 tracking-[0.12em] uppercase mb-1">Live Multiplier</div>
          <div
            className={`font-mono text-4xl font-black ${
              state?.live.crashed ? "text-[#FF1744]" : "text-[#00E676]"
            }`}
          >
            {liveMultiplier.toFixed(2)}x
          </div>
          <div className="mt-2 font-mono text-[10px] text-white/45">
            {bettingOpen && state ? `Betting closes in ${secondsLeft(state.round.bettingClosesAt)}s` : null}
            {runningNow && state && state.round.settlesAt
              ? `Crashes in ${secondsLeft(state.round.settlesAt)}s`
              : null}
            {state?.live.crashed ? `Round crashed at ${state.round.crashMultiplier.toFixed(2)}x` : null}
          </div>
          {state && (
            <div className="mt-3 px-4">
              <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-100 ${
                    state.live.crashed ? "bg-[#FF1744]" : "bg-[#00E676]"
                  }`}
                  style={{
                    width: `${Math.max(0, Math.min(100, ((liveMultiplier - 1) / Math.max(0.01, state.round.crashMultiplier - 1)) * 100))}%`,
                  }}
                />
              </div>
            </div>
          )}
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
        <div className="font-mono text-[10px] text-white/40 tracking-[0.14em] uppercase mb-2">Bet Amount (TC)</div>
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
            disabled={!user || !bettingOpen || busy || !!activeMyBet || selectedBet > (user?.tradeCredits ?? 0)}
            className="pressable rounded-xl py-3 font-mono text-xs font-bold border border-[#4DA3FF]/40 bg-[#4DA3FF]/15 text-[#8BC3FF] disabled:opacity-35"
          >
            Place Bet
          </button>
          <button
            onClick={handleCashout}
            type="button"
            disabled={!canCashout || busy || cashoutPending}
            className="pressable rounded-xl py-3 font-mono text-xs font-bold border border-[#00E676]/40 bg-[#00E676]/15 text-[#91ffca] disabled:opacity-35"
          >
            {cashoutPending ? "Cashing out..." : "Cashout Now"}
          </button>
        </div>

        {!user && (
          <div className="mt-2 font-mono text-[10px] text-[#FFD700]/75">
            Sign in with Telegram to place crash bets.
          </div>
        )}
        {remainingDailyGc !== null && remainingDailyGc <= 0 && (
          <div className="mt-2 font-mono text-[10px] text-[#FF1744]/85">
            Daily GC cap reached. Wins resolve, but payout stays 0 until reset.
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
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/45">Recent Crash Rounds</span>
        </div>
        <div className="space-y-2">
          {history.map((row) => (
            <div key={row.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 flex items-center">
              <span className="font-mono text-[10px] text-white/45">#{row.id}</span>
              <span className="ml-2 font-mono text-xs text-[#FFD700]">{row.crashMultiplier.toFixed(2)}x</span>
              <span
                className={`ml-auto font-mono text-[10px] ${
                  row.status === "crashed" ? "text-[#FF1744]" : "text-[#00E676]"
                }`}
              >
                {(row.status ?? "active").toUpperCase()}
              </span>
            </div>
          ))}
          {!history.length && <div className="font-mono text-xs text-white/30">No rounds yet.</div>}
        </div>
      </div>

      <div className="app-card p-4">
        <div className="flex items-center gap-1.5 mb-2">
          <TrendingUp size={13} className="text-white/55" />
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/45">My Crash Bets</span>
        </div>
        <div className="space-y-2">
          {myBets.map((bet) => (
            <div key={bet.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <div className="flex items-center">
                <span className="font-mono text-[10px] text-white/45">Round #{bet.roundId}</span>
                <span className="ml-auto font-mono text-[10px] text-white/45">{bet.amountTc} TC</span>
              </div>
              <div className="mt-1 flex items-center">
                <span
                  className={`font-mono text-[10px] ${
                    bet.status === "cashed_out"
                      ? "text-[#00E676]"
                      : bet.status === "lost"
                        ? "text-[#FF1744]"
                        : "text-[#FFD700]"
                  }`}
                >
                  {bet.status}
                </span>
                <span className="ml-auto font-mono text-[10px] text-white/65">
                  {bet.status === "cashed_out" || bet.status === "cashed"
                    ? `+${bet.payoutGc} GC @ ${(bet.cashoutAt ?? bet.cashoutMultiplier ?? 1).toFixed(2)}x`
                    : null}
                  {bet.status === "lost" ? `Crashed @ ${bet.crashMultiplier ?? "?"}x` : null}
                  {bet.status === "active" || bet.status === "pending" ? "In play..." : null}
                </span>
              </div>
            </div>
          ))}
          {!myBets.length && <div className="font-mono text-xs text-white/30">No crash bets yet.</div>}
        </div>
      </div>
    </div>
  );
}

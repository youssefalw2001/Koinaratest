import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bomb,
  Gem,
  Shield,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  Grid3x3,
  RotateCcw,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";

type GridSize = 3 | 4 | 5;

type ActiveRound = {
  roundId: number;
  gridSize: GridSize;
  minesCount: number;
  bet: number;
  serverSeedHash: string;
  clientSeed: string;
  revealed: number[];
  multiplier: number;
};

type RevealSafeResponse = {
  isMine: false;
  tile: number;
  revealed: number[];
  multiplier: number;
  status: "active";
};

type RevealBustResponse = {
  isMine: true;
  tile: number;
  revealed: number[];
  multiplier: number;
  status: "busted";
  mines: number[];
  serverSeed: string;
};

type RevealWinAllResponse = {
  isMine: false;
  tile: number;
  revealed: number[];
  multiplier: number;
  status: "cashed_out";
  payout: number;
  mines: number[];
  serverSeed: string;
};

type RevealResponse = RevealSafeResponse | RevealBustResponse | RevealWinAllResponse;

type CashoutResponse = {
  status: "cashed_out";
  revealed: number[];
  multiplier: number;
  payout: number;
  mines: number[];
  serverSeed: string;
  balances: { tradeCredits: number };
};

type LastResult =
  | { kind: "win"; payout: number; multiplier: number; mines: number[]; serverSeed: string }
  | { kind: "bust"; tile: number; mines: number[]; serverSeed: string };

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

const GRID_SIZES: GridSize[] = [3, 4, 5];
const DEFAULT_MINES: Record<GridSize, number> = { 3: 2, 4: 3, 5: 5 };
const MIN_BET = 50;

function randomClientSeed(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(window.Telegram?.WebApp?.initData
      ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
      : {}),
    ...extra,
  };
}

export default function Mines() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();

  const [gridSize, setGridSize] = useState<GridSize>(5);
  const [minesCount, setMinesCount] = useState<number>(DEFAULT_MINES[5]);
  const [bet, setBet] = useState<string>("100");
  const [clientSeed, setClientSeed] = useState<string>(() => randomClientSeed());

  const [active, setActive] = useState<ActiveRound | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [revealingTile, setRevealingTile] = useState<number | null>(null);
  const lockRef = useRef(false);

  // Hydrate any in-progress round on mount.
  useEffect(() => {
    if (!user) return;
    let aborted = false;
    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/mines/active/${encodeURIComponent(user.telegramId)}`), {
          headers: headers(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { active: ActiveRound | null };
        if (!aborted && data.active) {
          setActive(data.active);
          setGridSize(data.active.gridSize as GridSize);
          setMinesCount(data.active.minesCount);
          setBet(String(data.active.bet));
          setClientSeed(data.active.clientSeed);
        }
      } catch {
        /* ignore hydration errors */
      }
    })();
    return () => {
      aborted = true;
    };
  }, [user]);

  const totalTiles = gridSize * gridSize;
  const maxMines = totalTiles - 2;
  const betNum = useMemo(() => {
    const n = Number(bet);
    return Number.isFinite(n) && n >= MIN_BET ? Math.floor(n) : MIN_BET;
  }, [bet]);

  useEffect(() => {
    // Keep minesCount in range when grid size changes.
    if (active) return;
    const max = gridSize * gridSize - 2;
    setMinesCount((m) => Math.min(Math.max(m, 1), max));
  }, [gridSize, active]);

  const handleStart = async () => {
    if (!user || busy || active) return;
    if (betNum < MIN_BET) {
      setError(`Minimum bet is ${MIN_BET} TC.`);
      return;
    }
    if ((user.tradeCredits ?? 0) < betNum) {
      setError("Insufficient Trade Credits.");
      return;
    }
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const seed = clientSeed.trim() || randomClientSeed();
      const res = await fetch(apiUrl("/api/mines/start"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          telegramId: user.telegramId,
          gridSize,
          minesCount,
          bet: betNum,
          clientSeed: seed,
        }),
      });
      const data = (await res.json()) as (ActiveRound & { balances?: { tradeCredits: number } }) | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to start round.");
      }
      const round = data as ActiveRound;
      setActive(round);
      setClientSeed(round.clientSeed);
      refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start round.");
    } finally {
      setBusy(false);
    }
  };

  const handleReveal = async (tile: number) => {
    if (!user || !active || busy || lockRef.current) return;
    if (active.revealed.includes(tile)) return;
    lockRef.current = true;
    setBusy(true);
    setRevealingTile(tile);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/mines/reveal"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          telegramId: user.telegramId,
          roundId: active.roundId,
          tile,
        }),
      });
      const data = (await res.json()) as RevealResponse | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to reveal tile.");
      }
      const result = data as RevealResponse;
      if (result.status === "busted") {
        setActive((prev) => (prev ? { ...prev, revealed: result.revealed, multiplier: 0 } : null));
        setLastResult({
          kind: "bust",
          tile: result.tile,
          mines: result.mines,
          serverSeed: result.serverSeed,
        });
        setActive(null);
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      } else if (result.status === "cashed_out") {
        setLastResult({
          kind: "win",
          payout: result.payout,
          multiplier: result.multiplier,
          mines: result.mines,
          serverSeed: result.serverSeed,
        });
        setActive(null);
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      } else {
        setActive((prev) =>
          prev
            ? { ...prev, revealed: result.revealed, multiplier: result.multiplier }
            : null,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reveal tile.");
    } finally {
      setBusy(false);
      setRevealingTile(null);
      lockRef.current = false;
    }
  };

  const handleCashout = async () => {
    if (!user || !active || busy) return;
    if (active.revealed.length === 0) {
      setError("Reveal at least one tile before cashing out.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/mines/cashout"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ telegramId: user.telegramId, roundId: active.roundId }),
      });
      const data = (await res.json()) as CashoutResponse | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to cash out.");
      }
      const ok = data as CashoutResponse;
      setLastResult({
        kind: "win",
        payout: ok.payout,
        multiplier: ok.multiplier,
        mines: ok.mines,
        serverSeed: ok.serverSeed,
      });
      setActive(null);
      refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cash out.");
    } finally {
      setBusy(false);
    }
  };

  const nextSafe = Math.max(0, totalTiles - minesCount - (active?.revealed.length ?? 0));
  const nextMultiplier = active
    ? (() => {
        const rev = active.revealed.length;
        const safe = totalTiles - active.minesCount;
        if (rev + 1 > safe) return active.multiplier;
        let m = 1;
        for (let i = 0; i < rev + 1; i++) m *= (totalTiles - i) / (safe - i);
        return +(0.99 * m).toFixed(4);
      })()
    : 1;

  const gridMines = active?.minesCount ?? minesCount;
  const renderGrid = () => {
    const size = active?.gridSize ?? gridSize;
    const total = size * size;
    const revealed = active?.revealed ?? [];
    const bustedMines =
      lastResult?.kind === "bust" ? new Set(lastResult.mines) : null;
    const wonMines =
      lastResult?.kind === "win" ? new Set(lastResult.mines) : null;
    const tiles = Array.from({ length: total }, (_, i) => i);
    return (
      <div
        className="grid gap-1.5 mx-auto"
        style={{
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          maxWidth: size === 5 ? 360 : size === 4 ? 320 : 240,
        }}
      >
        {tiles.map((idx) => {
          const isRevealed = revealed.includes(idx);
          const isBusted = bustedMines?.has(idx);
          const isWonMine = wonMines?.has(idx);
          const justRevealed = revealingTile === idx;
          return (
            <motion.button
              key={idx}
              whileTap={active ? { scale: 0.92 } : undefined}
              animate={justRevealed ? { scale: [1, 1.1, 1] } : undefined}
              onClick={() => handleReveal(idx)}
              disabled={!active || busy || isRevealed}
              className={`aspect-square rounded-lg border font-mono text-sm font-black flex items-center justify-center transition ${
                isBusted
                  ? "border-[#FF1744]/55 bg-[#FF1744]/25 text-[#FF1744]"
                  : isWonMine
                    ? "border-[#FF1744]/25 bg-[#FF1744]/10 text-[#FF1744]/70"
                    : isRevealed
                      ? "border-[#00E676]/45 bg-[#00E676]/12 text-[#00E676]"
                      : active
                        ? "border-white/15 bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"
                        : "border-white/10 bg-white/[0.02] text-white/25"
              }`}
            >
              {isBusted ? (
                <Bomb size={16} />
              ) : isWonMine ? (
                <Bomb size={14} />
              ) : isRevealed ? (
                <Gem size={14} />
              ) : (
                ""
              )}
            </motion.button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-4">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-1">
          <Bomb size={14} className="text-[#FF1744]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">Mines</span>
        </div>
        <div className="font-mono text-[11px] text-white/45 mb-3">
          Uncover gems to grow your multiplier. Hit a mine and you lose the stake.
          Cash out any time.
        </div>

        {!active && (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {GRID_SIZES.map((size) => (
                <button
                  key={size}
                  onClick={() => setGridSize(size)}
                  className={`py-2 rounded-lg border font-mono text-[11px] font-black transition ${
                    gridSize === size
                      ? "border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700]"
                      : "border-white/10 text-white/50"
                  }`}
                >
                  {size}×{size}
                </button>
              ))}
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 mb-3">
              <div className="font-mono text-[10px] text-white/45 mb-1">Mines</div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={maxMines}
                  value={minesCount}
                  onChange={(e) => setMinesCount(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="font-mono text-sm font-black text-[#FF1744] w-8 text-right">
                  {minesCount}
                </span>
              </div>
              <div className="font-mono text-[9px] text-white/35 mt-1">
                Max {maxMines}. More mines = fewer safe tiles = higher multiplier jumps.
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 mb-3">
              <div className="font-mono text-[10px] text-white/45 mb-1">Bet</div>
              <input
                inputMode="numeric"
                value={bet}
                onChange={(e) => setBet(e.target.value.replace(/[^0-9]/g, ""))}
                className="w-full bg-transparent outline-none font-mono text-lg font-black text-white"
                placeholder={String(MIN_BET)}
              />
              <div className="font-mono text-[9px] text-white/35 mt-1">
                Min {MIN_BET} TC · Balance {(user?.tradeCredits ?? 0).toLocaleString()} TC
              </div>
            </div>

            <details className="mb-3">
              <summary className="font-mono text-[10px] text-white/45 cursor-pointer select-none">
                Provably fair · client seed
              </summary>
              <input
                value={clientSeed}
                onChange={(e) => setClientSeed(e.target.value.slice(0, 128))}
                className="mt-2 w-full rounded-lg border border-white/10 bg-white/[0.02] px-2 py-1 font-mono text-[10px] text-white/70 outline-none"
              />
              <button
                onClick={() => setClientSeed(randomClientSeed())}
                className="mt-1 font-mono text-[9px] text-[#FFD700]/75 underline"
              >
                Regenerate
              </button>
            </details>

            <button
              onClick={handleStart}
              disabled={busy || !user || betNum > (user?.tradeCredits ?? 0)}
              className="w-full py-3 rounded-xl font-mono text-xs font-black border border-[#00E676]/45 bg-[#00E676]/12 text-[#00E676] disabled:opacity-35"
            >
              {busy ? "STARTING..." : "START ROUND"}
            </button>
          </>
        )}

        {active && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
              <div className="font-mono text-[9px] text-white/45">Bet</div>
              <div className="font-mono text-xs font-black text-white">
                {active.bet.toLocaleString()} TC
              </div>
            </div>
            <div className="rounded-xl border border-[#FF1744]/25 bg-[#FF1744]/8 px-3 py-2">
              <div className="font-mono text-[9px] text-[#FF1744]/75">Mines</div>
              <div className="font-mono text-xs font-black text-[#FF1744]">{gridMines}</div>
            </div>
            <div className="rounded-xl border border-[#00E676]/25 bg-[#00E676]/8 px-3 py-2">
              <div className="font-mono text-[9px] text-[#00E676]/75">Multiplier</div>
              <div className="font-mono text-xs font-black text-[#00E676]">
                {active.multiplier.toFixed(2)}×
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="app-card p-4">{renderGrid()}</div>

      {active && (
        <div className="flex gap-2">
          <button
            onClick={handleCashout}
            disabled={busy || active.revealed.length === 0}
            className="flex-1 py-3 rounded-xl font-mono text-xs font-black border border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700] disabled:opacity-35 flex items-center justify-center gap-1.5"
          >
            <DollarSign size={12} />
            CASH OUT · {Math.floor(active.bet * active.multiplier).toLocaleString()} TC
          </button>
          <div className="px-3 py-3 rounded-xl border border-white/10 bg-white/[0.02] font-mono text-[10px] text-white/55 flex items-center gap-1.5">
            <Shield size={10} className="text-[#4DA3FF]" />
            Next · {nextMultiplier.toFixed(2)}× ({nextSafe} safe left)
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/10 px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={12} className="text-[#ffb3c2]" />
          <span className="font-mono text-xs text-[#ffb3c2]">{error}</span>
        </div>
      )}

      <AnimatePresence>
        {lastResult && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={`app-card p-4 border ${
              lastResult.kind === "win"
                ? "border-[#FFD700]/40"
                : "border-[#FF1744]/40"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              {lastResult.kind === "win" ? (
                <CheckCircle2 size={14} className="text-[#FFD700]" />
              ) : (
                <Bomb size={14} className="text-[#FF1744]" />
              )}
              <span
                className={`font-mono text-xs tracking-[0.14em] uppercase ${
                  lastResult.kind === "win" ? "text-[#FFD700]" : "text-[#FF1744]"
                }`}
              >
                {lastResult.kind === "win" ? "Cashed Out" : "Busted"}
              </span>
            </div>
            {lastResult.kind === "win" ? (
              <div className="font-mono text-sm text-white">
                +{lastResult.payout.toLocaleString()} TC at {lastResult.multiplier.toFixed(2)}×
              </div>
            ) : (
              <div className="font-mono text-sm text-white">
                Mine at tile #{lastResult.tile + 1} — stake lost.
              </div>
            )}
            <details className="mt-2">
              <summary className="font-mono text-[10px] text-white/45 cursor-pointer select-none">
                Verify this round
              </summary>
              <div className="font-mono text-[10px] text-white/55 mt-1 break-all">
                server seed: {lastResult.serverSeed}
              </div>
              <div className="font-mono text-[10px] text-white/55 mt-1 break-all">
                mines: {lastResult.mines.map((m) => `#${m + 1}`).join(", ")}
              </div>
            </details>
            <button
              onClick={() => {
                setLastResult(null);
                setClientSeed(randomClientSeed());
              }}
              className="mt-3 w-full py-2 rounded-lg font-mono text-[11px] font-black border border-white/15 text-white/75 flex items-center justify-center gap-1.5"
            >
              <RotateCcw size={11} />
              New Round
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 flex items-center gap-2">
        <Grid3x3 size={12} className="text-white/35" />
        <span className="font-mono text-[10px] text-white/45">
          Mine positions are derived from HMAC(serverSeed, clientSeed). Seed hash is committed at round start and revealed on settle.
        </span>
      </div>
    </div>
  );
}

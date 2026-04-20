import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeftRight, RefreshCw, TrendingUp, AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type ArbitrageQuote = {
  signalId: string;
  pair: string;
  direction: "long" | "short";
  spreadBps: number;
  confidencePct: number;
  referencePrice: number | null;
  expiresAt: string;
};

type ExecuteResponse = {
  signalId: string;
  pair: string;
  direction: "long" | "short";
  spreadBps: number;
  confidencePct: number;
  stakeTc: number;
  outcome: "win" | "loss";
  profitTc: number;
  totalReturnTc: number;
  balances: {
    tradeCredits: number;
  };
};

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

function secondsLeft(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

function makeIdempotencyKey(prefix: string, parts: Array<string | number>): string {
  return `${prefix}:${parts.map((entry) => String(entry)).join(":")}:${Date.now()}`;
}

export default function Arbitrage() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();

  const [quote, setQuote] = useState<ArbitrageQuote | null>(null);
  const [stakeTc, setStakeTc] = useState<number>(200);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const requestHeaders = {
    "Content-Type": "application/json",
    ...(window.Telegram?.WebApp?.initData
      ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
      : {}),
  };

  const fetchQuote = async () => {
    if (!user || loadingQuote) return;
    setLoadingQuote(true);
    setError(null);
    try {
      const res = await fetch(
        apiUrl(`/api/features/arbitrage/${encodeURIComponent(user.telegramId)}`),
        {
          method: "GET",
          headers: window.Telegram?.WebApp?.initData
            ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
            : undefined,
        },
      );
      const payload = (await res.json()) as ArbitrageQuote & { error?: string };
      if (!res.ok || !payload.signalId) {
        throw new Error(payload.error ?? "Failed to fetch arbitrage quote.");
      }
      setQuote(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not fetch quote.");
    } finally {
      setLoadingQuote(false);
    }
  };

  const executeQuote = async () => {
    if (!user || !quote || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/features/arbitrage/execute"), {
        method: "POST",
        headers: {
          ...requestHeaders,
          "Idempotency-Key": makeIdempotencyKey("arbitrage", [
            user.telegramId,
            quote.signalId,
            stakeTc,
          ]),
        },
        body: JSON.stringify({
          telegramId: user.telegramId,
          signalId: quote.signalId,
          stakeTc,
        }),
      });
      const payload = (await res.json()) as ExecuteResponse & { error?: string };
      if (!res.ok || !payload.signalId) {
        throw new Error(payload.error ?? "Arbitrage execution failed.");
      }
      if (payload.outcome === "win") {
        setNotice(`Arbitrage win: +${payload.profitTc} TC`);
      } else {
        setNotice(`Arbitrage loss: -${stakeTc} TC`);
      }
      setQuote(null);
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      setTimeout(() => setNotice(null), 2600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed.");
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="p-4 pb-8 flex flex-col gap-3">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <ArrowLeftRight size={16} className="text-[#00f0ff]" />
          <span className="font-mono text-xs tracking-[0.14em] uppercase text-white/65">Digital Arbitrage</span>
        </div>
        <div className="font-mono text-[11px] text-white/45">
          Scan a short-lived cross-exchange spread and execute one-click capture for Trade Credits.
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-[#ff2d78]/35 bg-[#ff2d78]/10 px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={13} className="text-[#ff2d78] shrink-0" />
          <span className="font-mono text-xs text-[#ffb3c6]">{error}</span>
        </div>
      )}
      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="rounded-xl border border-[#00E676]/35 bg-[#00E676]/10 px-3 py-2 flex items-center gap-2"
          >
            <CheckCircle2 size={13} className="text-[#00E676] shrink-0" />
            <span className="font-mono text-xs text-[#9cffca]">{notice}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="app-card p-4">
        <div className="mb-3">
          <div className="font-mono text-[10px] text-white/40 mb-1.5 uppercase tracking-wider">
            Stake (TC)
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[100, 200, 500, 1000].map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => setStakeTc(amount)}
                className={`rounded-lg py-1.5 font-mono text-[10px] border ${
                  stakeTc === amount
                    ? "border-[#00f0ff]/50 bg-[#00f0ff]/15 text-[#8ef7ff]"
                    : "border-white/10 text-white/45"
                }`}
              >
                {amount}
              </button>
            ))}
          </div>
        </div>
        {!quote ? (
          <button
            type="button"
            onClick={fetchQuote}
            disabled={!user || loadingQuote}
            className="w-full py-3 rounded-xl border border-[#00f0ff]/40 bg-[#00f0ff]/10 text-[#8ef7ff] font-mono text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-2"
          >
            <RefreshCw size={14} className={loadingQuote ? "animate-spin" : ""} />
            {loadingQuote ? "SCANNING..." : "SCAN ARBITRAGE QUOTE"}
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[11px] text-white/65">{quote.pair}</span>
                <span className="font-mono text-[10px] text-[#f5c518]">{secondsLeft(quote.expiresAt)}s left</span>
              </div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-[10px] text-white/45">Direction</span>
                <span className="font-mono text-[11px] text-white">{quote.direction.toUpperCase()}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div className="rounded-lg border border-white/10 p-2">
                  <div className="font-mono text-[9px] text-white/35">REFERENCE</div>
                  <div className="font-mono text-sm text-white">
                    {quote.referencePrice ? `$${quote.referencePrice.toLocaleString()}` : "N/A"}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 p-2">
                  <div className="font-mono text-[9px] text-white/35">CONFIDENCE</div>
                  <div className="font-mono text-sm text-white">{quote.confidencePct}%</div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-white/45">Spread</span>
                <span className="font-mono text-[11px] text-[#00E676]">{quote.spreadBps} bps</span>
              </div>
            </div>

            <button
              type="button"
              onClick={executeQuote}
              disabled={executing || secondsLeft(quote.expiresAt) <= 0}
              className="w-full py-3 rounded-xl border border-[#00E676]/40 bg-[#00E676]/10 text-[#9cffca] font-mono text-xs font-bold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              <TrendingUp size={14} />
              {executing ? "EXECUTING..." : "EXECUTE ARBITRAGE"}
            </button>
            <button
              type="button"
              onClick={() => setQuote(null)}
              className="w-full py-2 rounded-xl border border-white/10 text-white/45 font-mono text-[11px]"
            >
              Discard Quote
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

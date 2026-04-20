import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gift, Sparkles, Gem, Coins, CheckCircle2, AlertTriangle } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";

type LootboxResponse = {
  tier: "basic" | "pro";
  gcCost: number;
  rewardType: "tc" | "gc" | "jackpot_tc";
  rewardAmount: number;
  balances: {
    goldCoins: number;
    tradeCredits: number;
  };
};

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

export default function Lootbox() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<"basic" | "pro">("basic");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LootboxResponse | null>(null);

  const handleOpen = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/features/lootbox/open"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `lootbox:${user.telegramId}:${tier}:${Date.now()}`,
          ...(window.Telegram?.WebApp?.initData
            ? { "X-Telegram-Init-Data": window.Telegram.WebApp.initData }
            : {}),
        },
        body: JSON.stringify({ telegramId: user.telegramId, tier }),
      });
      const data = (await res.json()) as LootboxResponse | { error?: string };
      if (!res.ok) {
        throw new Error((data as { error?: string }).error ?? "Failed to open lootbox.");
      }
      setResult(data as LootboxResponse);
      refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open lootbox.");
    } finally {
      setBusy(false);
    }
  };

  const gc = user?.goldCoins ?? 0;
  const openCost = tier === "pro" ? 300 : 120;
  const canOpen = !!user && gc >= openCost;

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-4">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Gift size={16} className="text-[#FFD700]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">Lootbox</span>
        </div>
        <div className="font-mono text-[11px] text-white/45 mb-3">
          Open randomized lootboxes to farm TC/GC and occasional jackpot rewards.
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            onClick={() => setTier("basic")}
            className={`py-2 rounded-lg border font-mono text-xs ${
              tier === "basic"
                ? "border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700]"
                : "border-white/10 text-white/50"
            }`}
          >
            Basic
          </button>
          <button
            onClick={() => setTier("pro")}
            className={`py-2 rounded-lg border font-mono text-xs ${
              tier === "pro"
                ? "border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700]"
                : "border-white/10 text-white/50"
            }`}
          >
            Pro
          </button>
        </div>
        <div className="rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 flex items-center justify-between">
          <span className="font-mono text-[11px] text-white/60">Cost</span>
          <span className="font-mono text-sm font-black text-[#FFD700]">{openCost} GC</span>
        </div>

        <button
          onClick={handleOpen}
          disabled={!canOpen || busy}
          className="w-full mt-3 py-3 rounded-xl font-mono text-xs font-black border border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700] disabled:opacity-35"
        >
          {busy ? "OPENING..." : "OPEN LOOTBOX"}
        </button>

        {!canOpen && (
          <div className="mt-2 flex items-center gap-1.5 text-[#ff7171]">
            <AlertTriangle size={12} />
            <span className="font-mono text-[10px]">Need at least {openCost} GC to open.</span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="app-card p-4 border border-[#00E676]/30"
          >
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 size={14} className="text-[#00E676]" />
              <span className="font-mono text-xs text-[#00E676] tracking-[0.14em] uppercase">Loot Result</span>
            </div>
            <div className="font-mono text-sm text-white">
              {(result.rewardType === "tc" || result.rewardType === "jackpot_tc") && (
                <span className="inline-flex items-center gap-1">
                  <Coins size={13} className="text-[#4DA3FF]" />
                  +{result.rewardAmount} TC
                </span>
              )}
              {result.rewardType === "gc" && (
                <span className="inline-flex items-center gap-1">
                  <Gem size={13} className="text-[#FFD700]" />
                  +{result.rewardAmount} GC
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <div className="rounded-xl border border-[#FF1744]/30 bg-[#FF1744]/10 px-3 py-2">
          <span className="font-mono text-xs text-[#ffb3c2]">{error}</span>
        </div>
      )}
    </div>
  );
}

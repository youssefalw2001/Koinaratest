import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Gift,
  Sparkles,
  Gem,
  Coins,
  CheckCircle2,
  AlertTriangle,
  Crown,
  Rocket,
  PackageOpen,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useLanguage } from "@/lib/language";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";

type Tier = "basic" | "pro" | "mega";

type RewardType =
  | "tc"
  | "gc"
  | "jackpot_tc"
  | "mega_tc"
  | "mega_gc_multiplier"
  | "mega_vip_trial"
  | "mega_shop_powerup";

type LootboxResponse = {
  tier: Tier;
  gcCost: number;
  rewardType: RewardType;
  rewardAmount: number;
  rewardLabel: string | null;
  balances: {
    goldCoins: number;
    tradeCredits: number;
  };
};

const TIER_META: Record<
  Tier,
  { cost: number; label: string; blurb: string; accent: string }
> = {
  basic: {
    cost: 120,
    label: "Basic",
    blurb: "Small TC/GC rolls",
    accent: "#FFD700",
  },
  pro: {
    cost: 300,
    label: "Pro",
    blurb: "Richer jackpots",
    accent: "#FFD700",
  },
  mega: {
    cost: 500,
    label: "Mega",
    blurb: "TC bonus · 2× GC · VIP · Power-up",
    accent: "#9D5CFF",
  },
};

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

function rewardIcon(type: RewardType) {
  switch (type) {
    case "gc":
      return <Gem size={18} className="text-[#FFD700]" />;
    case "tc":
    case "jackpot_tc":
    case "mega_tc":
      return <Coins size={18} className="text-[#4DA3FF]" />;
    case "mega_gc_multiplier":
      return <Rocket size={18} className="text-[#9D5CFF]" />;
    case "mega_vip_trial":
      return <Crown size={18} className="text-[#FFD700]" />;
    case "mega_shop_powerup":
      return <PackageOpen size={18} className="text-[#00E676]" />;
    default:
      return <Sparkles size={18} className="text-white" />;
  }
}

function defaultLabel(res: LootboxResponse): string {
  if (res.rewardLabel) return res.rewardLabel;
  if (res.rewardType === "gc") return `+${res.rewardAmount} GC`;
  if (res.rewardType === "tc") return `+${res.rewardAmount} TC`;
  if (res.rewardType === "jackpot_tc") return `Jackpot! +${res.rewardAmount} TC`;
  return `+${res.rewardAmount}`;
}

export default function Lootbox() {
  const { user, refreshUser } = useTelegram();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<Tier>("basic");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LootboxResponse | null>(null);
  const [reveal, setReveal] = useState(false);

  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(false), 2200);
    return () => clearTimeout(t);
  }, [reveal]);

  const handleOpen = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
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
      setReveal(true);
      refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open lootbox.");
    } finally {
      setBusy(false);
    }
  };

  const gc = user?.goldCoins ?? 0;
  const meta = TIER_META[tier];
  const openCost = meta.cost;
  const canOpen = !!user && gc >= openCost;

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-4">
      <div className="app-card p-4">
        <div className="flex items-center gap-2 mb-2">
          <Gift size={16} className="text-[#FFD700]" />
          <span className="font-mono text-xs tracking-[0.16em] uppercase text-white/70">
            {t("lootbox")}
          </span>
        </div>
        <div className="font-mono text-[11px] text-white/45 mb-3">{t("lootboxBlurb")}</div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          {(Object.keys(TIER_META) as Tier[]).map((t) => {
            const m = TIER_META[t];
            const selected = tier === t;
            return (
              <button
                key={t}
                onClick={() => setTier(t)}
                className={`py-2 px-2 rounded-lg border font-mono text-[11px] flex flex-col gap-0.5 items-center transition ${
                  selected
                    ? t === "mega"
                      ? "border-[#9D5CFF]/55 bg-[#9D5CFF]/14 text-[#C7A6FF]"
                      : "border-[#FFD700]/45 bg-[#FFD700]/12 text-[#FFD700]"
                    : "border-white/10 text-white/50"
                }`}
              >
                <span className="font-black tracking-[0.14em] uppercase">{m.label}</span>
                <span className="text-[9px] opacity-70">{m.cost} GC</span>
              </button>
            );
          })}
        </div>

        <div className="font-mono text-[10px] text-white/45 mb-2 text-center">
          {meta.blurb}
        </div>

        <div
          className="rounded-xl border px-3 py-2 flex items-center justify-between"
          style={{
            borderColor: `${meta.accent}40`,
            background: `${meta.accent}14`,
          }}
        >
          <span className="font-mono text-[11px] text-white/60">{t("cost")}</span>
          <span
            className="font-mono text-sm font-black"
            style={{ color: meta.accent }}
          >
            {openCost} GC
          </span>
        </div>

        <button
          onClick={handleOpen}
          disabled={!canOpen || busy}
          className="w-full mt-3 py-3 rounded-xl font-mono text-xs font-black border disabled:opacity-35"
          style={{
            borderColor: `${meta.accent}73`,
            background: `${meta.accent}1E`,
            color: meta.accent,
          }}
        >
          {busy ? `${t("placing").toUpperCase()}...` : `${t("openLootbox").toUpperCase()} · ${meta.label.toUpperCase()}`}
        </button>

        {!canOpen && user && (
          <div className="mt-2 flex items-center gap-1.5 text-[#ff7171]">
            <AlertTriangle size={12} />
            <span className="font-mono text-[10px]">
              Need at least {openCost} GC to open.
            </span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {reveal && result && (
          <motion.div
            key={`reveal-${result.rewardType}-${result.rewardAmount}`}
            initial={{ opacity: 0, scale: 0.6, rotate: -6 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: "spring", stiffness: 260, damping: 16 }}
            className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center"
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div className="relative flex flex-col items-center gap-3">
              <motion.div
                animate={{ rotate: [0, -6, 6, -4, 4, 0] }}
                transition={{ duration: 0.9 }}
                className="w-24 h-24 rounded-2xl flex items-center justify-center"
                style={{
                  background:
                    result.tier === "mega"
                      ? "radial-gradient(circle at 30% 20%, #9D5CFF, #1a0a2e)"
                      : "radial-gradient(circle at 30% 20%, #FFD700, #2a1a04)",
                  boxShadow:
                    result.tier === "mega"
                      ? "0 0 40px #9D5CFF80"
                      : "0 0 40px #FFD70080",
                }}
              >
                <Sparkles size={36} className="text-white drop-shadow" />
              </motion.div>
              <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-black/70 px-3 py-2">
                {rewardIcon(result.rewardType)}
                <span className="font-mono text-sm text-white font-black">
                  {defaultLabel(result)}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
              <span className="font-mono text-xs text-[#00E676] tracking-[0.14em] uppercase">
                {t("lootResult")}
              </span>
            </div>
            <div className="font-mono text-sm text-white flex items-center gap-1.5">
              {rewardIcon(result.rewardType)}
              <span>{defaultLabel(result)}</span>
            </div>
            <div className="mt-2 font-mono text-[10px] text-white/45">
              Balance · {result.balances.goldCoins} GC · {result.balances.tradeCredits} TC
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

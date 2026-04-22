import { useEffect, useState, useCallback } from "react";
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
  Trophy,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { useLanguage } from "@/lib/language";
import { useQueryClient } from "@tanstack/react-query";
import { getGetUserQueryKey } from "@workspace/api-client-react";
import confetti from "canvas-confetti";

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
  { cost: number; label: string; blurb: string; accent: string; shadow: string }
> = {
  basic: {
    cost: 500, // Increased from 120
    label: "Basic",
    blurb: "Small TC/GC rolls",
    accent: "#FFD700",
    shadow: "rgba(255, 215, 0, 0.4)",
  },
  pro: {
    cost: 1500, // Increased from 300
    label: "Pro",
    blurb: "Richer jackpots",
    accent: "#00E676",
    shadow: "rgba(0, 230, 118, 0.4)",
  },
  mega: {
    cost: 5000, // Increased from 500
    label: "Mega",
    blurb: "TC bonus · 2× GC · VIP · Power-up",
    accent: "#9D5CFF",
    shadow: "rgba(157, 92, 255, 0.6)",
  },
};

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  return `${base}${path}`;
}

function rewardIcon(type: RewardType) {
  switch (type) {
    case "gc":
      return <Gem size={24} className="text-[#FFD700]" />;
    case "tc":
    case "jackpot_tc":
    case "mega_tc":
      return <Coins size={24} className="text-[#4DA3FF]" />;
    case "mega_gc_multiplier":
      return <Rocket size={24} className="text-[#9D5CFF]" />;
    case "mega_vip_trial":
      return <Crown size={24} className="text-[#FFD700]" />;
    case "mega_shop_powerup":
      return <PackageOpen size={24} className="text-[#00E676]" />;
    default:
      return <Sparkles size={24} className="text-white" />;
  }
}

function defaultLabel(res: LootboxResponse): string {
  if (res.rewardLabel) return res.rewardLabel;
  if (res.rewardType === "gc") return `+${res.rewardAmount} GC`;
  if (res.rewardType === "tc") return `+${res.rewardAmount} TC`;
  if (res.rewardType === "jackpot_tc") return `JACKPOT! +${res.rewardAmount} TC`;
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
  const [isOpening, setIsOpening] = useState(false);

  const triggerConfetti = useCallback((tier: Tier) => {
    const colors = tier === "mega" ? ["#9D5CFF", "#FFFFFF", "#C7A6FF"] : ["#FFD700", "#FFFFFF", "#FFA500"];
    confetti({
      particleCount: 150,
      spread: 70,
      origin: { y: 0.6 },
      colors,
      zIndex: 100,
    });
  }, []);

  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(false), 4000);
    return () => clearTimeout(t);
  }, [reveal]);

  const handleOpen = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setIsOpening(true);

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
      
      // Artificial delay for "dopamine" tension
      await new Promise(r => setTimeout(r, 1500));
      
      const lootResult = data as LootboxResponse;
      setResult(lootResult);
      setReveal(true);
      triggerConfetti(lootResult.tier);
      refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open lootbox.");
    } finally {
      setBusy(false);
      setIsOpening(false);
    }
  };

  const gc = user?.goldCoins ?? 0;
  const meta = TIER_META[tier];
  const openCost = meta.cost;
  const canOpen = !!user && gc >= openCost;

  return (
    <div className="px-4 pt-4 pb-8 flex flex-col gap-4 min-h-screen bg-black overflow-hidden">
      <div className="app-card p-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-10">
          <Trophy size={80} className="text-white" />
        </div>
        
        <div className="flex items-center gap-2 mb-2">
          <Gift size={20} className="text-[#FFD700] drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]" />
          <span className="font-mono text-sm tracking-[0.2em] uppercase text-white/80 font-black">
            {t("lootbox")}
          </span>
        </div>
        <div className="font-mono text-[12px] text-white/50 mb-6 leading-relaxed">
          {t("lootboxBlurb")}
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          {(Object.keys(TIER_META) as Tier[]).map((t) => {
            const m = TIER_META[t];
            const selected = tier === t;
            return (
              <button
                key={t}
                onClick={() => setTier(t)}
                className={`py-4 px-2 rounded-2xl border-2 font-mono flex flex-col gap-1 items-center transition-all duration-300 ${
                  selected
                    ? "scale-105 shadow-[0_0_20px_" + m.shadow + "]"
                    : "opacity-40 border-white/10"
                }`}
                style={{
                  borderColor: selected ? m.accent : "rgba(255,255,255,0.1)",
                  backgroundColor: selected ? `${m.accent}15` : "transparent",
                  color: selected ? "white" : "rgba(255,255,255,0.5)"
                }}
              >
                <span className="text-[12px] font-black tracking-widest uppercase">{m.label}</span>
                <span className="text-[10px] font-bold opacity-80">{m.cost.toLocaleString()} GC</span>
              </button>
            );
          })}
        </div>

        <motion.div 
          key={tier}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-mono text-[11px] text-white/60 mb-6 text-center italic bg-white/5 py-2 rounded-lg"
        >
          {meta.blurb}
        </motion.div>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleOpen}
          disabled={!canOpen || busy}
          className="w-full py-5 rounded-2xl font-mono text-sm font-black border-2 transition-all relative overflow-hidden group disabled:opacity-30"
          style={{
            borderColor: meta.accent,
            backgroundColor: `${meta.accent}20`,
            color: "white",
            boxShadow: `0 0 30px ${meta.shadow}`,
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
          <span className="relative flex items-center justify-center gap-2">
            {isOpening ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              >
                <Sparkles size={18} />
              </motion.div>
            ) : (
              <PackageOpen size={18} />
            )}
            {isOpening ? "OPENING VAULT..." : `OPEN ${meta.label.toUpperCase()} · ${openCost.toLocaleString()} GC`}
          </span>
        </motion.button>

        {!canOpen && user && (
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[#ff4d4d] animate-pulse">
            <AlertTriangle size={14} />
            <span className="font-mono text-[11px] font-bold">
              INSUFFICIENT GOLD COINS
            </span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {reveal && result && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
          >
            <div className="absolute inset-0 bg-black/90 backdrop-blur-xl" />
            
            <motion.div
              initial={{ scale: 0.5, rotate: -20, y: 50 }}
              animate={{ scale: 1, rotate: 0, y: 0 }}
              exit={{ scale: 1.5, opacity: 0 }}
              transition={{ type: "spring", damping: 12, stiffness: 200 }}
              className="relative flex flex-col items-center gap-6 w-full max-w-xs"
            >
              <div className="absolute -top-24 w-64 h-64 bg-white/5 rounded-full blur-3xl animate-pulse" 
                   style={{ backgroundColor: `${TIER_META[result.tier].accent}20` }} />
              
              <motion.div
                animate={{ 
                  y: [0, -15, 0],
                  rotate: [0, 5, -5, 0],
                  scale: [1, 1.05, 1]
                }}
                transition={{ repeat: Infinity, duration: 3 }}
                className="w-40 h-40 rounded-[2.5rem] flex items-center justify-center relative"
                style={{
                  background: `linear-gradient(135deg, ${TIER_META[result.tier].accent}, #000)`,
                  boxShadow: `0 0 60px ${TIER_META[result.tier].shadow}`,
                  border: `4px solid rgba(255,255,255,0.2)`
                }}
              >
                <div className="absolute inset-0 bg-white/10 rounded-[2.5rem] mix-blend-overlay" />
                <motion.div
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.3 }}
                >
                  {rewardIcon(result.rewardType)}
                </motion.div>
              </motion.div>

              <div className="flex flex-col items-center gap-2 text-center">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                  className="font-mono text-[10px] tracking-[0.3em] uppercase text-white/40"
                >
                  Reward Unlocked
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.6, type: "spring" }}
                  className="font-mono text-3xl font-black text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.3)]"
                >
                  {defaultLabel(result)}
                </motion.div>
              </div>

              <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.5 }}
                onClick={() => setReveal(false)}
                className="mt-4 px-8 py-3 rounded-full bg-white text-black font-mono text-xs font-black tracking-widest hover:scale-105 transition-transform"
              >
                COLLECT REWARD
              </motion.button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History Card */}
      <AnimatePresence>
        {result && !reveal && (
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="app-card p-5 border-l-4"
            style={{ borderLeftColor: TIER_META[result.tier].accent }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-[#00E676]" />
                <span className="font-mono text-[10px] text-white/50 tracking-widest uppercase font-black">
                  Latest Loot
                </span>
              </div>
              <span className="font-mono text-[9px] px-2 py-0.5 rounded bg-white/5 text-white/40 uppercase">
                {result.tier}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-white/5">
                {rewardIcon(result.rewardType)}
              </div>
              <div>
                <div className="font-mono text-lg font-black text-white">
                  {defaultLabel(result)}
                </div>
                <div className="font-mono text-[10px] text-white/40">
                  New Balance: {result.balances.goldCoins.toLocaleString()} GC
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {error && (
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border-2 border-[#FF1744]/30 bg-[#FF1744]/10 p-4 flex items-center gap-3"
        >
          <AlertTriangle size={18} className="text-[#FF1744]" />
          <span className="font-mono text-xs text-[#ffb3c2] font-bold">{error}</span>
        </motion.div>
      )}
    </div>
  );
}

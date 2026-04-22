import { useState, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap,
  Gift,
  Wallet,
  User,
  Crown,
  Clock,
  Gem,
  Languages,
  Sparkles,
  Bomb,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { parseVipExpiry, getVipCountdownLabel } from "@/lib/vipExpiry";
import { formatGcUsd } from "@/lib/format";
import { useLanguage } from "@/lib/language";

const tabs = [
  { path: "/", icon: Zap, labelKey: "trade" as const },
  { path: "/mines", icon: Bomb, labelKey: "mines" as const },
  { path: "/earn", icon: Gift, labelKey: "earn" as const },
  { path: "/shop", icon: Gem, labelKey: "shop" as const },
  { path: "/wallet", icon: Wallet, labelKey: "wallet" as const },
  { path: "/profile", icon: User, labelKey: "profile" as const },
];

function useTrialCountdown(vipTrialExpiresAt?: string | null): string | null {
  const [remaining, setRemaining] = useState<string | null>(null);
  useEffect(() => {
    if (!vipTrialExpiresAt) { setRemaining(null); return; }
    const update = () => {
      const expiresAt = parseVipExpiry(vipTrialExpiresAt);
      if (!expiresAt) { setRemaining(null); return; }
      const diff = expiresAt.getTime() - Date.now();
      if (diff <= 0) { setRemaining(null); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRemaining(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [vipTrialExpiresAt]);
  return remaining;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useTelegram();
  const { t, toggleLanguage, language, isArabic } = useLanguage();
  const vip = isVipActive(user);
  const hasPaidVip = !!(user?.isVip && parseVipExpiry(user?.vipExpiresAt) && parseVipExpiry(user?.vipExpiresAt)!.getTime() > Date.now());
  const hasTrial = !!(!hasPaidVip && parseVipExpiry(user?.vipTrialExpiresAt) && parseVipExpiry(user?.vipTrialExpiresAt)!.getTime() > Date.now());
  const trialCountdown = useTrialCountdown(hasTrial ? user?.vipTrialExpiresAt : null);
  const paidVipCountdown = getVipCountdownLabel(user?.vipExpiresAt);
  const tickerItems = useMemo(
    () => [
      "Aisha withdrew 42.50 USDT",
      "Faisal withdrew 19.80 USDT",
      "Youssef withdrew 77.10 USDT",
      "Mona withdrew 28.25 USDT",
      "Noura withdrew 54.90 USDT",
    ],
    [],
  );

  return (
    <div className="flex flex-col min-h-screen max-w-[420px] mx-auto text-white" dir={isArabic ? "rtl" : "ltr"}>
      <style>{`
        @keyframes vip-pulse {
          0%, 100% { box-shadow: 0 0 0 rgba(255, 215, 0, 0.2), 0 0 18px rgba(255, 215, 0, 0.25); }
          50% { box-shadow: 0 0 0 rgba(255, 215, 0, 0.4), 0 0 30px rgba(255, 215, 0, 0.55); }
        }
        @keyframes withdraw-ticker {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-[#FFD700]/15 bg-[#0a0a0f]/95 backdrop-blur-xl">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center"
              style={{
                background: "linear-gradient(135deg, #FFE88A, #FFD700)",
                boxShadow: "0 0 18px rgba(255,215,0,0.45)",
              }}
            >
              <span className="font-black text-[11px] text-black">K</span>
            </div>
            <span
              className="font-black text-sm tracking-[0.22em]"
              style={{
                background: "linear-gradient(90deg, #FFF3B0, #FFD700 46%, #D39B00)",
                WebkitBackgroundClip: "text",
                color: "transparent",
              }}
            >
              SOVEREIGN · {t("appName")}
            </span>
          </div>
          <button
            onClick={toggleLanguage}
            className="pressable inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/75"
            title={t("language")}
          >
            <Languages size={12} />
            {language === "en" ? "AR" : "EN"}
          </button>
        </div>
        {user && (
          <div className="px-4 pb-2 flex items-center gap-1.5">
            <div className="inline-flex items-center gap-1 rounded-full border border-[#4DA3FF]/35 bg-[#4DA3FF]/10 px-2.5 py-1">
              <span className="text-[10px]">🔵</span>
              <span className="font-mono text-[10px] font-bold text-[#8BC3FF] tabular-nums">
                {(user.tradeCredits ?? 0).toLocaleString()}
              </span>
              <span className="font-mono text-[8px] text-[#8BC3FF]/70">TC</span>
            </div>
            <div
              id="gc-balance-pill"
              className="inline-flex items-center gap-1 rounded-full border border-[#FFD700]/35 bg-[#FFD700]/10 px-2.5 py-1"
            >
              <span className="text-[10px]">🟡</span>
              <span className="font-mono text-[10px] font-bold text-[#FFD700] tabular-nums">
                {(user.goldCoins ?? 0).toLocaleString()}
              </span>
              <span className="font-mono text-[8px] text-[#FFD700]/70">GC</span>
              <span className="font-mono text-[8px] text-white/35">≈ {formatGcUsd(user.goldCoins ?? 0)}</span>
            </div>
            {vip && (
              <div
                className="ml-auto inline-flex items-center gap-1 rounded-full border border-[#FFD700]/45 bg-[#FFD700]/10 px-2.5 py-1"
                style={{ animation: "vip-pulse 3s ease-in-out infinite" }}
              >
                <Crown size={10} className="text-[#FFD700]" />
                <span className="font-mono text-[9px] font-black text-[#FFD700] tracking-[0.16em]">{t("vip")}</span>
              </div>
            )}
          </div>
        )}
        <div
          className="relative overflow-hidden border-t border-[#FFD700]/10"
          style={{ height: 24, background: "rgba(255,215,0,0.04)" }}
        >
          <div className="absolute left-0 top-0 flex whitespace-nowrap" style={{ animation: "withdraw-ticker 34s linear infinite" }}>
            {[...tickerItems, ...tickerItems].map((item, idx) => (
              <span key={`${item}-${idx}`} className="inline-flex items-center gap-1.5 px-5">
                <Sparkles size={9} className="text-[#FFD700]" />
                <span className="font-mono text-[9px] text-white/62">{item}</span>
              </span>
            ))}
          </div>
        </div>
      </header>

      {hasPaidVip && paidVipCountdown && (
        <div className="px-4 py-1.5 border-b border-[#f5c518]/15 bg-[#f5c518]/5">
          <div className="flex items-center gap-2">
            <Crown size={11} className="text-[#f5c518]" />
            <span className="font-mono text-[10px] text-[#f5c518]">VIP ACTIVE</span>
            <span className="font-mono text-[10px] text-white/40 ml-auto">{paidVipCountdown} remaining</span>
          </div>
        </div>
      )}

      {/* VIP Trial Countdown Banner */}
      {trialCountdown && (
        <div
          className="flex items-center gap-2 px-4 py-2 border-b"
          style={{
            borderColor: "rgba(255,45,120,0.3)",
            background: "linear-gradient(90deg, rgba(255,45,120,0.12) 0%, rgba(245,197,24,0.08) 100%)",
          }}
        >
          <Crown size={11} className="text-[#f5c518] shrink-0 drop-shadow-[0_0_4px_#f5c518]" />
          <span className="font-mono text-[10px] font-black text-[#f5c518]">VIP TRIAL</span>
          <div className="flex items-center gap-1 ml-auto">
            <Clock size={9} className="text-white/40" />
            <span className="font-mono text-[10px] text-white/60 tabular-nums">{trialCountdown} remaining</span>
          </div>
          <Link href="/wallet">
            <span className="font-mono text-[9px] text-[#ff2d78] border border-[#ff2d78]/40 px-1.5 py-0.5 rounded">Keep VIP</span>
          </Link>
        </div>
      )}

      <main className="flex-1 overflow-y-auto pb-20">
        <AnimatePresence mode="wait">
          <motion.div
            key={location}
            initial={{ opacity: 0, x: isArabic ? -14 : 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: isArabic ? 14 : -14 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="fixed bottom-0 left-0 right-0 max-w-[420px] mx-auto z-50 border-t border-[#FFD700]/10 bg-[#0a0a0f]/95 backdrop-blur-xl">
        <div className="flex">
          {tabs.map(({ path, icon: Icon, labelKey }) => {
            const active = location === path || (path !== "/" && location.startsWith(path));
            return (
              <Link key={path} href={path} className="flex-1">
                <div className={`relative flex flex-col items-center py-3 gap-1 transition-all duration-200 ${active ? "text-[#FFD700]" : "text-white/40"}`}>
                  {active && (
                    <span className="absolute top-1 h-1.5 w-1.5 rounded-full bg-[#FFD700] shadow-[0_0_10px_#FFD700]" />
                  )}
                  <Icon size={20} className={active ? "drop-shadow-[0_0_9px_#FFD700]" : ""} />
                  <span className="text-[9px] font-bold tracking-[0.14em] uppercase">{t(labelKey)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

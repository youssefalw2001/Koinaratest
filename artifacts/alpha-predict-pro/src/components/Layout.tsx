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
  Trophy,
  BookOpen,
  Rocket,
} from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { parseVipExpiry, getVipCountdownLabel } from "@/lib/vipExpiry";
import { formatGcUsd, FREE_GC_PER_USD, VIP_GC_PER_USD } from "@/lib/format";
import { useLanguage } from "@/lib/language";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

const tabs = [
  { path: "/", icon: Zap, label: "Trade" },
  { path: "/mines", icon: Bomb, label: "Mines" },
  { path: "/earn", icon: Gift, label: "Earn" },
  { path: "/creator", icon: Rocket, label: "Creator" },
  { path: "/exchange", icon: Gem, label: "Shop" },
  { path: "/wallet", icon: Wallet, label: "Wallet" },
];

const FREE_TRADE_CAP_GC = 7000;
const VIP_TRADE_CAP_GC = 20000;
const FREE_MINES_CAP_GC = 5000;
const VIP_MINES_CAP_GC = 20000;

type PublicActivity = { type?: string; name?: string; amountUsd?: number; network?: string };

const COMMUNITY_NAMES = [
  "Aisha", "Faisal", "Youssef", "Mona", "Noura", "Omar", "Layla", "Zain", "Amira", "Khalid",
  "Rohan", "Aarav", "Isha", "Priya", "Arjun", "Kabir", "Neha", "Vihaan", "Anaya", "Dev",
  "@crypto_hawk", "@koinhunter", "@mena_alpha", "@btc_rider", "@desi_trader", "@tonpilot",
  "Fatima", "Hassan", "Sara", "Ali", "Noor", "Mariam", "Ibrahim", "Huda", "Reem", "Tariq",
  "Rahul", "Meera", "Aditya", "Kavya", "Sanjay", "Nikhil", "Pooja", "Ayaan", "Riya", "Vikram",
  "@alpha_uae", "@koin_miner", "@chartboss", "@creatorx", "@btc_signal", "@mines_pro",
];

function buildCommunityTicker(language: "en" | "hi" | "ar"): string[] {
  const englishActions = [
    "opened BTC chart", "joined Creator", "unlocked Creator Pass", "started a Mines round", "shared a creator link",
    "claimed daily TC", "entered Alpha Terminal", "checked CR balance", "opened Wallet", "joined from Telegram",
  ];
  const hindiActions = [
    "ने BTC chart खोला", "Creator में जुड़ा", "ने Creator Pass unlock किया", "ने Mines round शुरू किया", "ने creator link share किया",
    "ने daily TC claim किया", "Alpha Terminal में आया", "ने CR balance देखा", "ने Wallet खोला", "Telegram से joined",
  ];
  return COMMUNITY_NAMES.map((name, index) => {
    if (language === "hi") return `${name} ${hindiActions[index % hindiActions.length]}`;
    return `${name} ${englishActions[index % englishActions.length]}`;
  });
}

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

function useDailyResetCountdown(): string {
  const [remaining, setRemaining] = useState("00:00");
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const reset = new Date(now);
      reset.setHours(24, 0, 0, 0);
      const diff = Math.max(0, reset.getTime() - now.getTime());
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setRemaining(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);
  return remaining;
}

function languageShortLabel(language: "en" | "hi" | "ar"): string {
  return language === "hi" ? "EN" : "HI";
}

function languageFullLabel(language: "en" | "hi" | "ar"): string {
  return language === "hi" ? "English" : "हिंदी";
}

function formatCrPill(cr: number): string {
  if (cr >= 1000) return `${cr.toLocaleString()} CR ≈ $${(cr / 1000).toFixed(2)}`;
  return `${cr.toLocaleString()} CR`;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useTelegram();
  const u = user as any;
  const { t, toggleLanguage, language, isArabic } = useLanguage();
  const [realTickerItems, setRealTickerItems] = useState<string[]>([]);
  const vip = isVipActive(user);
  const gcRate = vip ? VIP_GC_PER_USD : FREE_GC_PER_USD;
  const creatorPassPaid = !!u?.creatorPassPaid || vip;
  const creatorCredits = u?.creatorCredits ?? 0;
  const hasPaidVip = !!(user?.isVip && parseVipExpiry(user?.vipExpiresAt) && parseVipExpiry(user?.vipExpiresAt)!.getTime() > Date.now());
  const hasTrial = !!(!hasPaidVip && parseVipExpiry(user?.vipTrialExpiresAt) && parseVipExpiry(user?.vipTrialExpiresAt)!.getTime() > Date.now());
  const trialCountdown = useTrialCountdown(hasTrial ? user?.vipTrialExpiresAt : null);
  const paidVipCountdown = getVipCountdownLabel(user?.vipExpiresAt);
  const resetCountdown = useDailyResetCountdown();
  const tradeCap = vip ? VIP_TRADE_CAP_GC : FREE_TRADE_CAP_GC;
  const minesCap = vip ? VIP_MINES_CAP_GC : FREE_MINES_CAP_GC;
  const tradeEarned = user?.dailyGcEarned ?? 0;
  const tradePct = Math.min(100, Math.round((tradeEarned / tradeCap) * 100));
  const tradeCapped = tradeEarned >= tradeCap;

  useEffect(() => {
    let cancelled = false;
    const loadFeed = async () => {
      try {
        const res = await fetch(`${API_BASE}/activity/feed`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json() as { items?: PublicActivity[] };
        const items = (Array.isArray(data.items) ? data.items : [])
          .filter((item) => item.type === "withdrawal" && item.name && Number(item.amountUsd) > 0)
          .slice(0, 100)
          .map((item) => `${item.name} withdrew ${Number(item.amountUsd).toFixed(2)} ${item.network ?? "USDT"}`);
        if (!cancelled) setRealTickerItems(items);
      } catch {}
    };
    loadFeed();
    const timer = window.setInterval(loadFeed, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const tickerItems = useMemo(
    () => realTickerItems.length > 0 ? realTickerItems : buildCommunityTicker(language),
    [language, realTickerItems],
  );

  return (
    <div className="flex flex-col min-h-screen max-w-[420px] mx-auto text-white bg-[#050508]" dir={isArabic ? "rtl" : "ltr"}>
      <style>{`
        @keyframes vip-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(255, 215, 0, 0.1), 0 0 12px rgba(255, 215, 0, 0.15); } 50% { box-shadow: 0 0 0 rgba(255, 215, 0, 0.2), 0 0 20px rgba(255, 215, 0, 0.3); } }
        @keyframes withdraw-ticker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        @keyframes creator-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
        .premium-glass { background: rgba(10, 10, 15, 0.8); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
        .gold-text-gradient { background: linear-gradient(135deg, #FFF9E0 0%, #FFD700 45%, #B8860B 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>
      <header className="sticky top-0 z-40 border-b border-white/[0.05] premium-glass">
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center relative overflow-hidden group" style={{ background: "linear-gradient(135deg, #1a1a1a 0%, #000 100%)", border: "1px solid rgba(255, 215, 0, 0.3)", boxShadow: "0 0 15px rgba(255, 215, 0, 0.15)" }}><div className="absolute inset-0 bg-gradient-to-tr from-[#FFD700]/10 to-transparent opacity-50" /><span className="font-black text-[12px] gold-text-gradient relative z-10">K</span></div>
            <div className="flex flex-col"><span className="font-black text-[13px] tracking-[0.35em] gold-text-gradient uppercase leading-none">KOINARA</span><span className="text-[7px] text-white/30 tracking-[0.4em] uppercase mt-1 font-bold">Alpha Terminal</span></div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/profile"><button className="pressable inline-flex items-center justify-center w-8 h-8 rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] transition-colors" aria-label={t("profile")}><User size={14} className="text-white/60" /></button></Link>
            <Link href="/academy"><button className="pressable inline-flex items-center justify-center w-8 h-8 rounded-full border border-[#FFD700]/25 bg-[#FFD700]/[0.06] hover:bg-[#FFD700]/10 transition-colors" aria-label="Koinara Academy"><BookOpen size={14} className="text-[#FFD700] drop-shadow-[0_0_8px_rgba(255,215,0,.35)]" /></button></Link>
            <Link href="/leaderboard"><button className="pressable inline-flex items-center justify-center w-8 h-8 rounded-full border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] transition-colors" aria-label={t("leaderboard")}><Trophy size={14} className="text-white/60" /></button></Link>
            <button onClick={toggleLanguage} title={`${t("language")}: ${languageFullLabel(language)}`} className="pressable inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[9px] font-bold text-white/60 hover:text-white transition-colors"><Languages size={11} />{languageShortLabel(language)}</button>
          </div>
        </div>

        {user && (
          <div className="px-5 pb-3 flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5"><div className="w-1.5 h-1.5 rounded-full bg-[#4DA3FF] shadow-[0_0_8px_#4DA3FF]" /><span className="font-mono text-[11px] font-bold text-[#8BC3FF] tabular-nums">{(user.tradeCredits ?? 0).toLocaleString()}</span><span className="font-mono text-[8px] text-white/30">TC</span></div>
            <div id="gc-balance-pill" className="inline-flex items-center gap-1.5 rounded-lg border border-[#FFD700]/20 bg-[#FFD700]/5 px-2.5 py-1.5"><div className="w-1.5 h-1.5 rounded-full bg-[#FFD700] shadow-[0_0_8px_#FFD700]" /><span className="font-mono text-[11px] font-bold text-[#FFD700] tabular-nums">{(user.goldCoins ?? 0).toLocaleString()}</span><span className="font-mono text-[8px] text-[#FFD700]/40">GC</span><span className="font-mono text-[8px] text-white/20 ml-1">≈ {formatGcUsd(user.goldCoins ?? 0, gcRate)}</span><span className="ml-1 h-3.5 w-px bg-[#FFD700]/12" /><span className={`inline-flex items-center gap-0.5 rounded-full px-1 py-0.5 font-mono text-[7px] font-black ${tradeCapped ? "bg-[#FFD700]/12 text-[#FFD700]" : "bg-[#4DA3FF]/10 text-[#8BC3FF]"}`} title={`Trade cap ${Math.min(tradeEarned, tradeCap).toLocaleString()} / ${tradeCap.toLocaleString()} GC`}><Zap size={8} />{tradeCapped ? "CAP" : `${tradePct}%`}</span><span className="inline-flex items-center gap-0.5 rounded-full bg-[#00F5A0]/8 px-1 py-0.5 font-mono text-[7px] font-black text-[#00F5A0]" title={`Mines cap ${minesCap.toLocaleString()} GC/day`}><Bomb size={8} />{(0).toString()}%</span>{tradeCapped && <span className="inline-flex items-center gap-0.5 font-mono text-[7px] font-black text-white/35 tabular-nums"><Clock size={8} />{resetCountdown}</span>}</div>
            {creatorPassPaid ? <div className="inline-flex items-center gap-1.5 rounded-lg border border-[#00F5A0]/30 bg-[#00F5A0]/5 px-2.5 py-1.5"><div className="w-1.5 h-1.5 rounded-full bg-[#00F5A0] shadow-[0_0_8px_#00F5A0]"/><span className="font-mono text-[11px] font-bold text-[#00F5A0] tabular-nums">{formatCrPill(creatorCredits)}</span></div> : <Link href="/earn"><span className="inline-flex items-center gap-1 rounded-lg border border-[#00F5A0]/25 bg-[#00F5A0]/7 px-2.5 py-1.5 font-mono text-[9px] font-black text-[#00F5A0]"><Rocket size={10}/>Creator</span></Link>}
            {vip && <div className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-[#FFD700]/30 bg-[#FFD700]/10 px-2.5 py-1.5" style={{ animation: "vip-pulse 4s ease-in-out infinite" }}><Crown size={11} className="text-[#FFD700]" /><span className="font-mono text-[9px] font-black text-[#FFD700] tracking-[0.12em]">VIP</span></div>}
          </div>
        )}

        <div className="relative overflow-hidden border-t border-white/[0.03]" style={{ height: 26, background: "rgba(0,0,0,0.2)" }}><div className="absolute left-0 top-0 flex items-center h-full whitespace-nowrap" style={{ animation: "withdraw-ticker 55s linear infinite" }}>{[...tickerItems, ...tickerItems].map((item, idx) => <span key={`${item}-${idx}`} className="inline-flex items-center gap-2 px-6"><Sparkles size={10} className={realTickerItems.length > 0 ? "text-[#FFD700]/45" : "text-[#00F5A0]/40"} /><span className="font-mono text-[9px] text-white/40 font-medium tracking-tight">{item}</span></span>)}</div></div>
      </header>

      {hasPaidVip && paidVipCountdown && <div className="px-5 py-2 border-b border-[#FFD700]/10 bg-[#FFD700]/[0.02]"><div className="flex items-center gap-2"><Crown size={12} className="text-[#FFD700]/60" /><span className="font-mono text-[10px] text-[#FFD700]/80 font-bold">PREMIUM ACTIVE</span><span className="font-mono text-[10px] text-white/30 ml-auto">{paidVipCountdown}</span></div></div>}
      {trialCountdown && <div className="flex items-center gap-3 px-5 py-2.5 border-b" style={{ borderColor: "rgba(255,215,0,0.1)", background: "linear-gradient(90deg, rgba(255,215,0,0.05) 0%, rgba(0,0,0,0) 100%)" }}><Crown size={12} className="text-[#FFD700] shrink-0 drop-shadow-[0_0_5px_rgba(255,215,0,0.5)]" /><span className="font-mono text-[10px] font-black text-[#FFD700] tracking-wider">EXCLUSIVE TRIAL</span><div className="flex items-center gap-1.5 ml-auto"><Clock size={10} className="text-white/20" /><span className="font-mono text-[10px] text-white/40 tabular-nums">{trialCountdown}</span></div><Link href="/wallet"><span className="font-mono text-[9px] text-[#FFD700] border border-[#FFD700]/30 px-2 py-0.5 rounded-md font-bold hover:bg-[#FFD700]/10 transition-colors">UPGRADE</span></Link></div>}
      <main className="flex-1 overflow-y-auto pb-24"><AnimatePresence mode="wait"><motion.div key={location} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}>{children}</motion.div></AnimatePresence></main>
      <nav className="fixed bottom-0 left-0 right-0 max-w-[420px] mx-auto z-50 border-t border-white/[0.05] premium-glass px-1"><div className="flex justify-around items-center h-20">{tabs.map((tab) => { const { path, icon: Icon } = tab; const active = location === path || (path !== "/" && location.startsWith(path)); return <Link key={path} href={path} className="relative group"><div className={`flex flex-col items-center py-2 px-1.5 gap-1.5 transition-all duration-300 ${active ? "text-[#FFD700]" : "text-white/30 hover:text-white/50"}`}><div className="relative">{active && <motion.div layoutId="nav-glow" className="absolute -inset-2 bg-[#FFD700]/10 blur-md rounded-full" />}<Icon size={18} className={`relative z-10 ${active ? "drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]" : ""}`} strokeWidth={active ? 2.5 : 2} />{tab.path === "/creator" && (!creatorPassPaid ? (<div className="absolute top-0 right-0 w-2 h-2 rounded-full bg-[#00F5A0]" style={{ animation: "creator-pulse 2s ease-in-out infinite", boxShadow: "0 0 6px #00F5A0" }} />) : creatorCredits >= 1000 ? (<div className="absolute -top-1 -right-2 rounded-full bg-[#00F5A0] text-black font-black leading-none px-1 py-0.5" style={{ fontSize: "8px" }}>{"$" + (creatorCredits / 1000).toFixed(1)}</div>) : creatorCredits > 0 ? (<div className="absolute top-0 right-0 w-2 h-2 rounded-full bg-[#00F5A0]" style={{ animation: "creator-pulse 2s ease-in-out infinite", boxShadow: "0 0 6px #00F5A0" }} />) : null)}</div><span className={`text-[7px] font-black tracking-[0.06em] uppercase relative z-10 ${active ? "opacity-100" : "opacity-60"}`}>{tab.label}</span>{active && <motion.div layoutId="nav-indicator" className="absolute -bottom-1 w-1 h-1 rounded-full bg-[#FFD700] shadow-[0_0_8px_#FFD700]" />}</div></Link>; })}</div></nav>
    </div>
  );
}

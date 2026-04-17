import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Zap, Gift, Wallet, Trophy, User, Crown, Clock } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { formatGcUsd } from "@/lib/format";

const CYAN = "#00f0ff";
const GOLD = "#f5c518";
const MAGENTA = "#ff2d78";

const tabs = [
  { path: "/", icon: Zap, label: "Trade" },
  { path: "/earn", icon: Gift, label: "Earn" },
  { path: "/wallet", icon: Wallet, label: "Wallet" },
  { path: "/leaderboard", icon: Trophy, label: "Ranks" },
  { path: "/profile", icon: User, label: "Profile" },
];

function useTrialCountdown(vipTrialExpiresAt?: string | null): string | null {
  const [remaining, setRemaining] = useState<string | null>(null);
  useEffect(() => {
    if (!vipTrialExpiresAt) { setRemaining(null); return; }
    const update = () => {
      const diff = new Date(vipTrialExpiresAt).getTime() - Date.now();
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
  const vip = isVipActive(user);
  const hasPaidVip = user?.isVip && user?.vipExpiresAt && new Date(user.vipExpiresAt) > new Date();
  const hasTrial = !hasPaidVip && user?.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt) > new Date();
  const trialCountdown = useTrialCountdown(hasTrial ? user?.vipTrialExpiresAt : null);

  return (
    <div className="flex flex-col min-h-screen max-w-[420px] mx-auto bg-black text-white">
      {/* Top Header */}
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 bg-black/95 backdrop-blur-xl border-b border-white/8">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-sm flex items-center justify-center" style={{ background: "linear-gradient(135deg, #00f0ff, #f5c518)" }}>
            <span className="font-black text-[10px] text-black">K</span>
          </div>
          <span className="font-mono font-black text-sm tracking-widest text-white">KOINARA</span>
        </div>
        {user && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-[#00f0ff]/8 border border-[#00f0ff]/20 rounded px-2 py-1">
              <span className="text-xs">🔵</span>
              <span className="font-mono text-xs text-[#00f0ff] font-bold">
                {(user.tradeCredits ?? 0).toLocaleString()}
              </span>
              <span className="font-mono text-[9px] text-[#00f0ff]/50">TC</span>
            </div>
            <div className="flex items-center gap-1 bg-[#f5c518]/8 border border-[#f5c518]/25 rounded px-2 py-1">
              <span className="text-xs">🪙</span>
              <span className="font-mono text-xs font-bold" style={{ color: GOLD }}>
                {(user.goldCoins ?? 0).toLocaleString()}
              </span>
              <span className="font-mono text-[9px]" style={{ color: GOLD + "70" }}>GC</span>
              <span className="font-mono text-[8px] text-white/40 ml-0.5">
                ≈ {formatGcUsd(user.goldCoins ?? 0)}
              </span>
            </div>
            {vip && (
              <div className="px-1.5 py-0.5 rounded border border-[#f5c518]/50 bg-[#f5c518]/10">
                <span className="font-mono text-[9px] font-black text-[#f5c518] tracking-widest">VIP</span>
              </div>
            )}
          </div>
        )}
      </header>

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
        {children}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 max-w-[420px] mx-auto z-50 border-t border-white/10 bg-black/95 backdrop-blur-xl">
        <div className="flex">
          {tabs.map(({ path, icon: Icon, label }) => {
            const active = location === path || (path !== "/" && location.startsWith(path));
            return (
              <Link key={path} href={path} className="flex-1">
                <div className={`flex flex-col items-center py-3 gap-1 transition-all duration-200 ${active ? "text-[#00f0ff]" : "text-white/40"}`}>
                  <Icon
                    size={20}
                    className={active ? "drop-shadow-[0_0_8px_#00f0ff]" : ""}
                  />
                  <span className="text-[9px] font-mono font-bold tracking-widest uppercase">{label}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

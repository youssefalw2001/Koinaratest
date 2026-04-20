import React, { useEffect, useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, CheckCircle, Flame, Star, Trophy } from "lucide-react";
import NotFound from "@/pages/not-found";
import { TelegramProvider } from "./lib/TelegramProvider";
import { useTelegram } from "./lib/TelegramProvider";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLocation } from "wouter";
import { useClaimDailyReward, getGetUserQueryKey } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { useQueryClient } from "@tanstack/react-query";
import { LanguageProvider } from "@/lib/language";

// Pages
import Terminal from "./pages/Terminal";
import Crash from "./pages/Crash";
import Earn from "./pages/Earn";
import Shop from "./pages/Shop";
import Wallet from "./pages/Wallet";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/Profile";
import Lootbox from "./pages/Lootbox";
import Arbitrage from "./pages/Arbitrage";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error(`[API Query Error] ${String(query.queryHash)}:`, error);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      const key = mutation.options.mutationKey ? ` ${String(mutation.options.mutationKey)}` : "";
      console.error(`[API Mutation Error]${key}:`, error);
    },
  }),
});

function VipPromoModal() {
  const { showVipPromo, dismissVipPromo } = useTelegram();
  const [, setLocation] = useLocation();

  const handleGoVip = () => {
    dismissVipPromo();
    setLocation("/wallet");
  };

  return (
    <AnimatePresence>
      {showVipPromo && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/85"
          onClick={dismissVipPromo}
        >
          <motion.div
            initial={{ y: 300 }}
            animate={{ y: 0 }}
            exit={{ y: 300 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="w-full max-w-[420px] p-6 pb-8 rounded-t-3xl border-t-2 border-[#f5c518]"
            style={{
              background: "linear-gradient(180deg, #0a0800 0%, #000000 100%)",
              boxShadow: "0 -25px 80px rgba(245,197,24,0.35)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mb-3 border-2 border-[#f5c518]"
                style={{ boxShadow: "0 0 30px rgba(245,197,24,0.5)", background: "rgba(245,197,24,0.1)" }}
              >
                <Crown size={32} className="text-[#f5c518] drop-shadow-[0_0_15px_#f5c518]" />
              </div>
              <div className="font-mono text-2xl font-black text-[#f5c518] mb-1">Go VIP Today</div>
              <div className="font-mono text-xs text-white/50 mb-4">
                Protect your earnings with TON subscription, 2× payouts & USDT withdrawal access
              </div>
              <div className="w-full space-y-2 mb-5">
                {[
                  "2× payout on every winning trade",
                  "3,000 GC daily earning cap",
                  "Withdraw GC as real USDT",
                  "25 ad rewards per day",
                ].map(perk => (
                  <div key={perk} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#f5c518]/20 bg-[#f5c518]/5">
                    <CheckCircle size={12} className="text-[#f5c518] shrink-0" />
                    <span className="font-mono text-xs text-white text-left">{perk}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={handleGoVip}
                className="w-full py-4 rounded-2xl font-mono text-base font-black text-black mb-3"
                style={{
                  background: "linear-gradient(90deg, #f5c518, #ff9900)",
                  boxShadow: "0 0 25px rgba(245,197,24,0.5)",
                }}
              >
                ACTIVATE VIP — TON PLAN
              </button>
              <button
                onClick={dismissVipPromo}
                className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors"
              >
                Not now
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DailyLoginPrompt() {
  const { user, showDailyLoginPrompt, dismissDailyLoginPrompt, refreshUser } = useTelegram();
  const qc = useQueryClient();
  const claimDaily = useClaimDailyReward();
  const claimedRef = useRef(false);
  const [claimedReward, setClaimedReward] = useState<{ tc: number; streak: number; isVip: boolean } | null>(null);

  // Auto-claim on first open: credit TC immediately without requiring a user button press.
  // The modal shows a confirmation notification and auto-dismisses after 3.5s.
  useEffect(() => {
    if (!showDailyLoginPrompt || !user || claimedRef.current) return;
    claimedRef.current = true;
    (async () => {
      try {
        const result = await claimDaily.mutateAsync({ data: { telegramId: user.telegramId } });
        const vip = isVipActive(user);
        setClaimedReward({ tc: result.tcAwarded, streak: result.streak, isVip: vip });
        qc.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        refreshUser();
      } catch {
        // Already claimed or error — just dismiss silently
      }
      setTimeout(() => dismissDailyLoginPrompt(), 3500);
    })();
  }, [showDailyLoginPrompt]);

  const accentColor = claimedReward?.isVip ? "#f5c518" : "#00f0ff";

  return (
    <AnimatePresence>
      {showDailyLoginPrompt && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/80"
          onClick={dismissDailyLoginPrompt}
        >
          <motion.div
            initial={{ y: 200 }}
            animate={{ y: 0 }}
            exit={{ y: 200 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="w-full max-w-[420px] p-6 pb-8 rounded-t-3xl border-t-2"
            style={{
              borderColor: accentColor,
              background: "linear-gradient(180deg, #050508 0%, #000000 100%)",
              boxShadow: `0 -20px 60px ${claimedReward?.isVip ? "rgba(245,197,24,0.3)" : "rgba(0,240,255,0.2)"}`,
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <Flame
                size={36}
                className="mb-3"
                style={{ color: accentColor, filter: `drop-shadow(0 0 15px ${accentColor})` }}
              />
              <div className="font-mono text-xs text-white/50 mb-1 tracking-widest uppercase">
                Daily Reward Credited
              </div>
              {claimedReward ? (
                <>
                  <div className="font-mono text-4xl font-black mb-1" style={{ color: accentColor }}>
                    +{claimedReward.tc} TC
                  </div>
                  <div className="font-mono text-sm text-white/50 mb-1">
                    {claimedReward.isVip ? "VIP Bonus — " : ""}Day {claimedReward.streak} streak
                  </div>
                </>
              ) : (
                <div className="font-mono text-white/40 text-sm mb-1">Crediting...</div>
              )}
              <div className="font-mono text-[10px] text-white/30 mb-6">
                Come back tomorrow for more!
              </div>
              <button
                onClick={dismissDailyLoginPrompt}
                className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Day7CelebrationModal() {
  const { showDay7Celebration, dismissDay7Celebration } = useTelegram();
  const [, setLocation] = useLocation();

  return (
    <AnimatePresence>
      {showDay7Celebration && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-end justify-center bg-black/90"
          onClick={dismissDay7Celebration}
        >
          <motion.div
            initial={{ y: 400, scale: 0.9 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 400 }}
            transition={{ type: "spring", damping: 22, stiffness: 280 }}
            className="w-full max-w-[420px] p-6 pb-10 rounded-t-3xl border-t-2 border-[#00f0ff]"
            style={{
              background: "linear-gradient(180deg, #050a0a 0%, #000000 100%)",
              boxShadow: "0 -30px 100px rgba(0,240,255,0.3)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="relative mb-4">
                <Trophy size={52} className="text-[#00f0ff] drop-shadow-[0_0_25px_#00f0ff]" />
                <Star size={18} className="absolute -top-1 -right-2 text-[#f5c518] drop-shadow-[0_0_8px_#f5c518]" />
              </div>
              <div className="font-mono text-[10px] text-[#00f0ff]/60 tracking-widest uppercase mb-1">Day 7 Survivor</div>
              <div className="font-mono text-3xl font-black text-white mb-2">Bonus Unlocked!</div>
              <div className="font-mono text-[#00f0ff] text-4xl font-black mb-1">+3,000 TC</div>
              <div className="font-mono text-xs text-white/40 mb-1">+ 24h VIP Trial</div>
              <div className="font-mono text-[10px] text-white/30 mb-8">
                You've survived 7 days in the arena. The market respects consistency.
              </div>
              <button
                onClick={() => { dismissDay7Celebration(); setLocation("/"); }}
                className="w-full py-4 rounded-2xl font-mono text-base font-black mb-3"
                style={{
                  background: "linear-gradient(90deg, #00f0ff, #0080ff)",
                  color: "#000",
                  boxShadow: "0 0 30px rgba(0,240,255,0.5)",
                }}
              >
                KEEP TRADING
              </button>
              <button
                onClick={dismissDay7Celebration}
                className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Bounded({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

function Router() {
  const [crashMode, setCrashMode] = useState<"enabled" | "coming_soon">("enabled");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const resp = await fetch("/api/features");
        if (!resp.ok) throw new Error("Feature flags unavailable");
        const json = (await resp.json()) as { crashEnabled?: boolean };
        if (!mounted) return;
        setCrashMode(json.crashEnabled === false ? "coming_soon" : "enabled");
      } catch {
        // Fail open: keep crash tab available unless backend explicitly disables it.
        if (!mounted) return;
        setCrashMode("enabled");
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Layout>
      <Switch>
        <Route path="/" component={() => <Bounded><Terminal /></Bounded>} />
        <Route
          path="/crash"
          component={() =>
            <Bounded>
              {crashMode === "enabled" ? <Crash /> : (
                <div className="px-4 pt-6 pb-8">
                  <div className="app-card p-5 border border-[#FFD700]/20 bg-[#FFD700]/5 text-center">
                    <div className="font-mono text-sm text-[#FFD700] tracking-[0.18em] uppercase mb-2">
                      Crash Arena
                    </div>
                    <div className="font-mono text-xl font-black text-white mb-2">
                      Coming Soon
                    </div>
                    <div className="font-mono text-xs text-white/50">
                      We are upgrading Crash for full server-authoritative fairness and stability.
                    </div>
                  </div>
                </div>
              )}
            </Bounded>
          }
        />
        <Route path="/lootbox" component={() => <Bounded><Lootbox /></Bounded>} />
        <Route path="/arbitrage" component={() => <Bounded><Arbitrage /></Bounded>} />
        <Route path="/earn" component={() => <Bounded><Earn /></Bounded>} />
        <Route path="/shop" component={() => <Bounded><Shop /></Bounded>} />
        <Route path="/wallet" component={() => <Bounded><Wallet /></Bounded>} />
        <Route path="/leaderboard" component={() => <Bounded><Leaderboard /></Bounded>} />
        <Route path="/profile" component={() => <Bounded><Profile /></Bounded>} />
        <Route component={NotFound} />
      </Switch>
      <VipPromoModal />
      <DailyLoginPrompt />
      <Day7CelebrationModal />
    </Layout>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <TonConnectUIProvider manifestUrl={`${window.location.origin}${import.meta.env.BASE_URL}tonconnect-manifest.json`}>
      <QueryClientProvider client={queryClient}>
        <LanguageProvider>
          <TelegramProvider>
            <TooltipProvider>
              <ErrorBoundary>
                <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <Router />
                </WouterRouter>
                <Toaster />
              </ErrorBoundary>
            </TooltipProvider>
          </TelegramProvider>
        </LanguageProvider>
      </QueryClientProvider>
    </TonConnectUIProvider>
  );
}

export default App;

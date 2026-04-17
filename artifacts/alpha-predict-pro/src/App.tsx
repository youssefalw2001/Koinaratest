import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, CheckCircle, Flame } from "lucide-react";
import NotFound from "@/pages/not-found";
import { TelegramProvider } from "./lib/TelegramProvider";
import { useTelegram } from "./lib/TelegramProvider";
import { Layout } from "./components/Layout";
import { useLocation } from "wouter";
import { useClaimDailyReward, getGetUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

// Pages
import Terminal from "./pages/Terminal";
import Earn from "./pages/Earn";
import Wallet from "./pages/Wallet";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/Profile";

const queryClient = new QueryClient();

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
                Protect your earnings with 2× payouts & USDT withdrawal access
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
                ACTIVATE VIP — 500 TC
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

  const handleClaim = async () => {
    if (!user) return;
    try {
      await claimDaily.mutateAsync({ data: { telegramId: user.telegramId } });
      qc.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      refreshUser();
    } catch {}
    dismissDailyLoginPrompt();
  };

  const streak = user?.loginStreak ?? 0;
  const isVip = user?.isVip;
  const reward = isVip ? 150 + streak * 15 : 100 + streak * 10;

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
              borderColor: isVip ? "#f5c518" : "#00f0ff",
              background: "linear-gradient(180deg, #050508 0%, #000000 100%)",
              boxShadow: isVip ? "0 -20px 60px rgba(245,197,24,0.3)" : "0 -20px 60px rgba(0,240,255,0.2)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <Flame
                size={36}
                className="mb-3"
                style={{
                  color: isVip ? "#f5c518" : "#00f0ff",
                  filter: `drop-shadow(0 0 15px ${isVip ? "#f5c518" : "#00f0ff"})`,
                }}
              />
              <div className="font-mono text-xs text-white/50 mb-1 tracking-widest uppercase">Daily Reward</div>
              <div
                className="font-mono text-4xl font-black mb-1"
                style={{ color: isVip ? "#f5c518" : "#00f0ff" }}
              >
                +{reward} TC
              </div>
              <div className="font-mono text-sm text-white/50 mb-1">
                {isVip ? "VIP Bonus — " : ""}Day {streak + 1} streak
              </div>
              <div className="font-mono text-[10px] text-white/30 mb-6">
                Come back tomorrow for more!
              </div>
              <button
                onClick={handleClaim}
                disabled={claimDaily.isPending}
                className="w-full py-4 rounded-2xl font-mono text-base font-black mb-3"
                style={{
                  background: isVip
                    ? "linear-gradient(90deg, #f5c518, #ff9900)"
                    : "linear-gradient(90deg, #00f0ff, #0080ff)",
                  color: isVip ? "#000" : "#000",
                  boxShadow: isVip ? "0 0 25px rgba(245,197,24,0.5)" : "0 0 25px rgba(0,240,255,0.4)",
                }}
              >
                {claimDaily.isPending ? "CLAIMING..." : `CLAIM ${reward} TC`}
              </button>
              <button
                onClick={dismissDailyLoginPrompt}
                className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors"
              >
                Later
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Terminal} />
        <Route path="/earn" component={Earn} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/leaderboard" component={Leaderboard} />
        <Route path="/profile" component={Profile} />
        <Route component={NotFound} />
      </Switch>
      <VipPromoModal />
      <DailyLoginPrompt />
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
        <TelegramProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
            <Toaster />
          </TooltipProvider>
        </TelegramProvider>
      </QueryClientProvider>
    </TonConnectUIProvider>
  );
}

export default App;

import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, CheckCircle } from "lucide-react";
import NotFound from "@/pages/not-found";
import { TelegramProvider } from "./lib/TelegramProvider";
import { useTelegram } from "./lib/TelegramProvider";
import { Layout } from "./components/Layout";
import { useLocation } from "wouter";

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

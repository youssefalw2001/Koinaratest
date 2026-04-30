import React, { useEffect, useRef, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TonConnectUIProvider, useTonAddress, useTonConnectUI } from "@tonconnect/ui-react";
import { motion, AnimatePresence } from "framer-motion";
import { Crown, CheckCircle, Flame, Star, Trophy } from "lucide-react";
import NotFound from "@/pages/not-found";
import { TelegramProvider } from "./lib/TelegramProvider";
import { useTelegram } from "./lib/TelegramProvider";
import { Layout } from "./components/Layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLocation } from "wouter";
import { useClaimDailyReward, getGetUserQueryKey, useUpdateWallet } from "@workspace/api-client-react";
import { isVipActive } from "@/lib/vipActive";
import { useQueryClient } from "@tanstack/react-query";
import { LanguageProvider } from "@/lib/language";
import { withRequiredMemo } from "@/lib/tonPayment";

// Pages
import Terminal from "./pages/TradeCapGuard";
import Mines from "./pages/MinesWithFeedback";
import Earn from "./pages/EarnCreatorLaunch";
import Shop from "./pages/ShopPremiumLaunch";
import Wallet from "./pages/WalletSimplified";
import Leaderboard from "./pages/Leaderboard";
import Profile from "./pages/ProfilePremiumLaunch";
import Academy from "./pages/Academy";
import Lootbox from "./pages/Lootbox";
import CreatorCenter from "./pages/CreatorCenter";

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => console.error(`[API Query Error] ${String(query.queryHash)}:`, error) }),
  mutationCache: new MutationCache({ onError: (error, _variables, _context, mutation) => console.error(`[API Mutation Error]${mutation.options.mutationKey ? ` ${String(mutation.options.mutationKey)}` : ""}:`, error) }),
});

const FREE_WITHDRAWAL_MIN_GC = 14000;
const FREE_TRADE_CAP_GC = 7000;
const FREE_MINES_CAP_GC = 5000;
const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;

function TonPaymentBridge() {
  const [tonConnectUI] = useTonConnectUI();
  const walletAddress = useTonAddress();
  const { user, refreshUser } = useTelegram();
  const updateWallet = useUpdateWallet();

  useEffect(() => {
    if (!tonConnectUI) return;
    const original = tonConnectUI.sendTransaction.bind(tonConnectUI);
    const bridged = Object.assign(tonConnectUI, {
      sendTransaction: (tx: any, options?: any) => {
        const patched = user?.telegramId ? withRequiredMemo(tx, user.telegramId) : tx;
        return original(patched, options);
      },
    });
    (window as any).tonConnectUI = bridged;
    return () => { (window as any).tonConnectUI = tonConnectUI; };
  }, [tonConnectUI, user?.telegramId]);

  useEffect(() => {
    if (!user?.telegramId || !walletAddress || user.walletAddress === walletAddress || updateWallet.isPending) return;
    updateWallet.mutate(
      { telegramId: user.telegramId, data: { walletAddress } },
      { onSuccess: () => refreshUser() },
    );
  }, [walletAddress, user?.telegramId, user?.walletAddress, updateWallet, refreshUser]);

  return null;
}

function MinesPassDirectPaymentBridge() {
  const [location] = useLocation();
  const { user, refreshUser } = useTelegram();
  const walletAddress = useTonAddress();

  useEffect(() => {
    if (location !== "/mines" && location !== "/crash") return;
    if (!user?.telegramId) return;

    const tierAmount: Record<string, Record<number, string>> = {
      bronze: { 1: "50000000", 5: "195000000", 10: "345000000" },
      silver: { 1: "100000000", 5: "390000000", 10: "690000000" },
      gold: { 1: "250000000", 5: "975000000", 10: "1725000000" },
    };

    const getSelectedTier = () => {
      const page = document.body.textContent?.toLowerCase() ?? "";
      if (page.includes("gold mode")) return "gold";
      if (page.includes("silver mode")) return "silver";
      return "bronze";
    };

    const getPackSize = (text: string) => {
      if (/10\s*[×x]/i.test(text)) return 10;
      if (/5\s*[×x]/i.test(text)) return 5;
      if (/1\s*[×x]/i.test(text)) return 1;
      return null;
    };

    const onClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest?.("button") as HTMLButtonElement | null;
      if (!button) return;
      const pageText = document.body.textContent ?? "";
      if (!pageText.includes("Round Passes")) return;
      const text = button.textContent ?? "";
      const packSize = getPackSize(text);
      if (!packSize) return;

      const tier = getSelectedTier();
      const amount = tierAmount[tier]?.[packSize];
      if (!amount) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const tonConnect = (window as any)?.tonConnectUI;
      if (!tonConnect) {
        window.alert?.("TON wallet is loading. Please try again.");
        return;
      }

      const operatorWallet = (import.meta.env.VITE_TON_WALLET || import.meta.env.VITE_KOINARA_TON_WALLET) as string | undefined;
      if (!operatorWallet) {
        window.alert?.("TON payments are not configured.");
        return;
      }

      if (!tonConnect.connected && typeof tonConnect.openModal === "function") {
        await tonConnect.openModal();
        window.alert?.("Connect your TON wallet, then tap the pass again to pay.");
        return;
      }

      const senderAddress = tonConnect.account?.address || walletAddress || user.walletAddress;
      if (!senderAddress) {
        window.alert?.("Connect your TON wallet, then tap the pass again to pay.");
        return;
      }

      try {
        await tonConnect.sendTransaction({ validUntil: Math.floor(Date.now() / 1000) + 600, messages: [{ address: operatorWallet, amount }] });
        await new Promise((r) => setTimeout(r, 5000));
        const initData = (window as any)?.Telegram?.WebApp?.initData ?? "";
        const res = await fetch(`${API_BASE}/mines/passes/purchase`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(initData ? { "x-telegram-init-data": initData } : {}) },
          body: JSON.stringify({ telegramId: user.telegramId, tier, packSize, senderAddress }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? "Payment verification failed. Please try again.");
        refreshUser();
        queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        window.alert?.(`${packSize}× ${tier} Mines pass added.`);
        window.location.reload();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Payment failed. Please try again.";
        window.alert?.(message.includes("Cancelled") || message.includes("rejected") ? "Transaction cancelled." : message);
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [location, user?.telegramId, user?.walletAddress, walletAddress, refreshUser]);

  return null;
}

function VipPromoModal() {
  const { showVipPromo, dismissVipPromo } = useTelegram();
  const [, setLocation] = useLocation();
  const [manualVipPromo, setManualVipPromo] = useState(false);
  const visible = showVipPromo || manualVipPromo;

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const link = target?.closest?.("a") as HTMLAnchorElement | null;
      const clickable = target?.closest?.("a,button") as HTMLElement | null;
      if (!clickable) return;
      const label = (clickable.textContent ?? "").toLowerCase();
      const href = link?.getAttribute("href") ?? "";
      const looksLikeVip = label.includes("activate vip") || label.includes("go vip") || label.includes("purchase vip");
      const goesWallet = href.endsWith("/wallet") || href === "/wallet";
      if (looksLikeVip && (goesWallet || label.includes("activate vip"))) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setManualVipPromo(true);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const dismiss = () => { setManualVipPromo(false); dismissVipPromo(); };
  const handleGoVip = () => {
    try { localStorage.setItem("koinara_auto_vip_checkout", "1"); } catch {}
    dismiss();
    setLocation("/wallet");
  };
  return (
    <AnimatePresence>
      {visible && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-end justify-center bg-black/85" onClick={dismiss}>
          <motion.div initial={{ y: 300 }} animate={{ y: 0 }} exit={{ y: 300 }} transition={{ type: "spring", damping: 25, stiffness: 300 }} className="w-full max-w-[420px] p-6 pb-8 rounded-t-3xl border-t-2 border-[#f5c518]" style={{ background: "linear-gradient(180deg, #0a0800 0%, #000000 100%)", boxShadow: "0 -25px 80px rgba(245,197,24,0.35)" }} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mb-3 border-2 border-[#f5c518]" style={{ boxShadow: "0 0 30px rgba(245,197,24,0.5)", background: "rgba(245,197,24,0.1)" }}><Crown size={32} className="text-[#f5c518] drop-shadow-[0_0_15px_#f5c518]" /></div>
              <div className="font-mono text-2xl font-black text-[#f5c518] mb-1">Unlock Koinara VIP</div>
              <div className="font-mono text-xs text-white/55 mb-4">Higher caps, better withdrawal rules, creator/referral upside, and premium earning room.</div>
              <div className="w-full space-y-2 mb-5">
                {[
                  "20,000 GC daily Trade cap instead of 7,000",
                  "20,000 GC daily Mines cap instead of 5,000",
                  "Lower withdrawal requirement + faster cashout path",
                  "Creator Pass included — referral commissions activated automatically",
                  "Monthly renewal rewards from active VIP referrals",
                ].map(perk => <div key={perk} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#f5c518]/20 bg-[#f5c518]/5"><CheckCircle size={12} className="text-[#f5c518] shrink-0" /><span className="font-mono text-xs text-white text-left">{perk}</span></div>)}
              </div>
              <button onClick={handleGoVip} className="w-full py-4 rounded-2xl font-mono text-base font-black text-black mb-3" style={{ background: "linear-gradient(90deg, #f5c518, #ff9900)", boxShadow: "0 0 25px rgba(245,197,24,0.5)" }}>PURCHASE NOW</button>
              <button onClick={dismiss} className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors">Not now</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function HomeWalletTrustPanel() {
  const { user } = useTelegram();
  const [location, setLocation] = useLocation();
  const vip = isVipActive(user);
  if (!user || location !== "/wallet") return null;
  const goldCoins = user.goldCoins ?? 0;
  const dailyGcEarned = user.dailyGcEarned ?? 0;
  const withdrawalProgress = Math.min(100, (goldCoins / FREE_WITHDRAWAL_MIN_GC) * 100);
  const tradeProgress = Math.min(100, (dailyGcEarned / FREE_TRADE_CAP_GC) * 100);
  return <section className="hidden"><button onClick={() => setLocation("/wallet")}>Wallet</button><span>{withdrawalProgress}{tradeProgress}{FREE_MINES_CAP_GC}{vip ? "vip" : "free"}</span></section>;
}

function DailyLoginPrompt() {
  const { user, showDailyLoginPrompt, dismissDailyLoginPrompt, refreshUser } = useTelegram();
  const qc = useQueryClient();
  const claimDaily = useClaimDailyReward();
  const claimedRef = useRef(false);
  const [claimedReward, setClaimedReward] = useState<{ tc: number; streak: number; isVip: boolean } | null>(null);
  useEffect(() => {
    if (!showDailyLoginPrompt || !user || claimedRef.current) return;
    claimedRef.current = true;
    (async () => {
      try {
        const result = await claimDaily.mutateAsync({ data: { telegramId: user.telegramId } });
        setClaimedReward({ tc: result.tcAwarded, streak: result.streak, isVip: isVipActive(user) });
        qc.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
        refreshUser();
      } catch {}
      setTimeout(() => dismissDailyLoginPrompt(), 3500);
    })();
  }, [showDailyLoginPrompt]);
  const accentColor = claimedReward?.isVip ? "#f5c518" : "#00f0ff";
  return (
    <AnimatePresence>
      {showDailyLoginPrompt && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] flex items-end justify-center bg-black/80" onClick={dismissDailyLoginPrompt}>
          <motion.div initial={{ y: 200 }} animate={{ y: 0 }} exit={{ y: 200 }} transition={{ type: "spring", damping: 25, stiffness: 300 }} className="w-full max-w-[420px] p-6 pb-8 rounded-t-3xl border-t-2" style={{ borderColor: accentColor, background: "linear-gradient(180deg, #050508 0%, #000000 100%)", boxShadow: `0 -20px 60px ${claimedReward?.isVip ? "rgba(245,197,24,0.3)" : "rgba(0,240,255,0.2)"}` }} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center"><Flame size={36} className="mb-3" style={{ color: accentColor, filter: `drop-shadow(0 0 15px ${accentColor})` }} /><div className="font-mono text-xs text-white/50 mb-1 tracking-widest uppercase">Daily Reward Credited</div>{claimedReward ? <><div className="font-mono text-4xl font-black mb-1" style={{ color: accentColor }}>+{claimedReward.tc} TC</div><div className="font-mono text-sm text-white/50 mb-1">{claimedReward.isVip ? "VIP Bonus - " : ""}Day {claimedReward.streak} streak</div></> : <div className="font-mono text-white/40 text-sm mb-1">Crediting...</div>}<div className="font-mono text-[10px] text-white/30 mb-6">Come back tomorrow for more!</div><button onClick={dismissDailyLoginPrompt} className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors">Close</button></div>
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
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-end justify-center bg-black/90" onClick={dismissDay7Celebration}>
          <motion.div initial={{ y: 400, scale: 0.9 }} animate={{ y: 0, scale: 1 }} exit={{ y: 400 }} transition={{ type: "spring", damping: 22, stiffness: 280 }} className="w-full max-w-[420px] p-6 pb-10 rounded-t-3xl border-t-2 border-[#00f0ff]" style={{ background: "linear-gradient(180deg, #050a0a 0%, #000000 100%)", boxShadow: "0 -30px 100px rgba(0,240,255,0.3)" }} onClick={e => e.stopPropagation()}>
            <div className="flex flex-col items-center text-center"><div className="relative mb-4"><Trophy size={52} className="text-[#00f0ff] drop-shadow-[0_0_25px_#00f0ff]" /><Star size={18} className="absolute -top-1 -right-2 text-[#f5c518] drop-shadow-[0_0_8px_#f5c518]" /></div><div className="font-mono text-[10px] text-[#00f0ff]/60 tracking-widest uppercase mb-1">Day 7 Survivor</div><div className="font-mono text-3xl font-black text-white mb-2">Bonus Unlocked!</div><div className="font-mono text-[#00f0ff] text-4xl font-black mb-1">+3,000 TC</div><div className="font-mono text-xs text-white/40 mb-1">+ 24h VIP Trial</div><div className="font-mono text-[10px] text-white/30 mb-8">You have survived 7 days in the arena. The market respects consistency.</div><button onClick={() => { dismissDay7Celebration(); setLocation("/"); }} className="w-full py-4 rounded-2xl font-mono text-base font-black mb-3" style={{ background: "linear-gradient(90deg, #00f0ff, #0080ff)", color: "#000", boxShadow: "0 0 30px rgba(0,240,255,0.5)" }}>KEEP TRADING</button><button onClick={dismissDay7Celebration} className="font-mono text-xs text-white/30 hover:text-white/50 transition-colors">Close</button></div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Bounded({ children }: { children: React.ReactNode }) { return <ErrorBoundary>{children}</ErrorBoundary>; }

function Router() {
  return (
    <Layout>
      <TonPaymentBridge />
      <MinesPassDirectPaymentBridge />
      <HomeWalletTrustPanel />
      <Switch>
        <Route path="/" component={() => <Bounded><Terminal /></Bounded>} />
        <Route path="/mines" component={() => <Bounded><Mines /></Bounded>} />
        <Route path="/crash" component={() => <Bounded><Mines /></Bounded>} />
        <Route path="/academy" component={() => <Bounded><Academy /></Bounded>} />
        <Route path="/lootbox" component={() => <Bounded><Lootbox /></Bounded>} />
        <Route path="/creator" component={() => <Bounded><CreatorCenter /></Bounded>} />
        <Route path="/exchange" component={() => <Bounded><Shop /></Bounded>} />
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
  useEffect(() => { document.documentElement.classList.add("dark"); }, []);
  return <TonConnectUIProvider manifestUrl={`${window.location.origin}${import.meta.env.BASE_URL}tonconnect-manifest.json`}><QueryClientProvider client={queryClient}><LanguageProvider><TelegramProvider><TooltipProvider><ErrorBoundary><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}><Router /></WouterRouter><Toaster /></ErrorBoundary></TooltipProvider></TelegramProvider></LanguageProvider></QueryClientProvider></TonConnectUIProvider>;
}
export default App;

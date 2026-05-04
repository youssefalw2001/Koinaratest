import { useMemo, useState, type ComponentType, type CSSProperties } from "react";
import { Link } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  CheckCircle,
  Coins,
  Crown,
  Flame,
  Gem,
  Gift,
  Lock,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
  Trophy,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import {
  getGetActiveGemsQueryKey,
  getGetUserQueryKey,
  useGetActiveGems,
  usePurchaseGem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTonConnectUI } from "@tonconnect/ui-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { PageError, PageLoader } from "@/components/PageStatus";
import { fetchTcPackMemo, paymentTx, verifyTcPackPurchase } from "@/lib/tonPayment";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

type GemType =
  | "starter_boost" | "big_swing" | "streak_saver" | "mystery_box" | "daily_refill"
  | "double_or_nothing" | "hot_streak" | "double_down" | "precision_lock" | "comeback_king"
  | "battle_shield" | "battle_pass" | "battle_streak_saver" | "battle_priority_queue"
  | "revenge_shield" | "safe_reveal" | "gem_magnet" | "second_chance";

type MinesGemType = "revenge_shield" | "safe_reveal" | "gem_magnet" | "second_chance";
type ShopTab = "tc" | "powerups" | "vip" | "boosts";

type PowerCard = { id: GemType; name: string; desc: string; cost: number; uses: string; icon: ComponentType<{ size?: number; className?: string; style?: CSSProperties }>; tone: string; badge?: string; vipOnly?: boolean; };
type TcPack = { id: "micro" | "starter" | "pro" | "whale"; name: string; price: string; priceTonNano: string; tc: number; desc: string; badge?: string; tone: string; icon: ComponentType<{ size?: number; className?: string; style?: CSSProperties }>; };

const TC_PACKS: TcPack[] = [
  { id: "micro", name: "Micro Play Refill", price: "$0.99", priceTonNano: "200000000", tc: 7000, desc: "Small Play Credit refill for Mines and Arcade activity.", badge: "FAST", tone: "#4DA3FF", icon: Zap },
  { id: "starter", name: "Starter Play Pack", price: "$2.99", priceTonNano: "600000000", tc: 30000, desc: "Best first Play Credit top-up for daily users.", badge: "BEST START", tone: "#B65CFF", icon: Star },
  { id: "pro", name: "Pro Play Pack", price: "$9.99", priceTonNano: "2000000000", tc: 150000, desc: "Built for active creators who play Mines and Arcade daily.", badge: "POPULAR", tone: "#FFD700", icon: Rocket },
  { id: "whale", name: "Power Play Pack", price: "$49.99", priceTonNano: "10000000000", tc: 1000000, desc: "Maximum Play Credits for high-volume Arcade users.", badge: "MAX", tone: "#00F5A0", icon: Flame },
];

const POWER_CARDS: PowerCard[] = [
  { id: "battle_shield", name: "Arcade Shield", desc: "If you lose your next Battle-style Arcade round, 70% of your TC stake is returned. No extra GC.", cost: 800, uses: "1 use", icon: ShieldCheck, tone: "#00F5A0", badge: "SAFE" },
  { id: "battle_pass", name: "Arcade Pass", desc: "7 days of premium Arcade status, priority queue, badge, and streak protection status.", cost: 3000, uses: "7 days", icon: Crown, tone: "#FFD700", badge: "WEEKLY" },
  { id: "battle_streak_saver", name: "Streak Saver", desc: "Protects your Arcade streak display from one loss. Does not change GC payout.", cost: 1200, uses: "1 use", icon: Trophy, tone: "#B65CFF" },
  { id: "battle_priority_queue", name: "Priority Queue", desc: "Get matched ahead of normal waiting players for 24 hours. No payout boost.", cost: 1000, uses: "24 hours", icon: Rocket, tone: "#4DA3FF" },
];

const BOOST_CARDS: PowerCard[] = [
  { id: "revenge_shield", name: "Revenge Shield", desc: "Absorbs one mine hit.", cost: 0, uses: "0.20 TON", icon: ShieldCheck, tone: "#00f5a0", badge: "MINES" },
  { id: "safe_reveal", name: "Safe Reveal", desc: "Reveal one safe tile.", cost: 0, uses: "0.10 TON", icon: Target, tone: "#4da3ff", badge: "MINES" },
  { id: "gem_magnet", name: "Gem Magnet", desc: "Boost three safe reveals.", cost: 0, uses: "0.15 TON", icon: Gem, tone: "#b65cff", badge: "MINES" },
  { id: "second_chance", name: "Second Chance", desc: "Refund once after a bust.", cost: 0, uses: "0.25 TON", icon: Star, tone: "#ffd700", badge: "MINES" },
];

function PremiumIcon({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <div className="h-12 w-12 rounded-2xl flex items-center justify-center border relative overflow-hidden" style={{ borderColor: `${tone}66`, background: `${tone}18`, boxShadow: `0 0 28px ${tone}26` }}><div className="absolute inset-0 bg-gradient-to-br from-white/15 to-transparent" /><div className="relative z-10">{children}</div></div>;
}
function isMinesGemType(value: GemType): value is MinesGemType { return value === "revenge_shield" || value === "safe_reveal" || value === "gem_magnet" || value === "second_chance"; }

export default function ShopPremiumLaunch() {
  const { user, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const [tonConnectUI] = useTonConnectUI();
  const vip = isVipActive(user);
  const [activeTab, setActiveTab] = useState<ShopTab>("tc");
  const [confirming, setConfirming] = useState<GemType | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  const [buyingPowerup, setBuyingPowerup] = useState<GemType | null>(null);
  const purchaseMutation = usePurchaseGem();
  const initData = (window as any)?.Telegram?.WebApp?.initData ?? "";

  const { data: activeGems, isLoading, isError, refetch } = useGetActiveGems(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") } });
  const activeGemCount = useMemo(() => Array.isArray(activeGems) ? activeGems.reduce((sum, item) => sum + Math.max(0, item.usesRemaining ?? 0), 0) : 0, [activeGems]);
  const battleGemCount = useMemo(() => Array.isArray(activeGems) ? activeGems.filter((item) => String(item.gemType).startsWith("battle_")).reduce((sum, item) => sum + Math.max(0, item.usesRemaining ?? 0), 0) : 0, [activeGems]);
  const cards = activeTab === "boosts" ? BOOST_CARDS : POWER_CARDS;
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3200); };
  const operatorWallet = (import.meta.env.VITE_TON_WALLET || import.meta.env.VITE_KOINARA_TON_WALLET) as string | undefined;

  const ensureWallet = async (): Promise<string> => {
    if (!tonConnectUI.connected) await tonConnectUI.openModal();
    const senderAddress = tonConnectUI.account?.address || user?.walletAddress;
    if (!senderAddress) throw new Error("Connect Tonkeeper first, then retry.");
    return senderAddress;
  };

  const handleBuyTcPack = async (pack: TcPack) => {
    if (!user || buyingPack) return;
    setBuyingPack(pack.id);
    try {
      const senderAddress = await ensureWallet();
      if (!operatorWallet) throw new Error("TON payments are not configured.");
      const memo = await fetchTcPackMemo({ telegramId: user.telegramId, packId: pack.id, initData });
      await tonConnectUI.sendTransaction(paymentTx(operatorWallet, pack.priceTonNano, memo));
      showToast("Payment sent. Verifying on-chain...");
      await new Promise((r) => setTimeout(r, 5000));
      await verifyTcPackPurchase({ telegramId: user.telegramId, packId: pack.id, senderAddress, initData });
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      showToast(`${pack.tc.toLocaleString()} Play TC added`);
    } catch (err) { showToast(err instanceof Error ? err.message : "TC pack purchase failed."); }
    finally { setBuyingPack(null); }
  };

  const handleBuyMinesPowerup = async (card: PowerCard) => {
    if (!user || !isMinesGemType(card.id) || buyingPowerup) return;
    setBuyingPowerup(card.id);
    try {
      const senderAddress = await ensureWallet();
      const memoUrl = `${API_BASE}/gems/powerups/memo?telegramId=${encodeURIComponent(user.telegramId)}&gemType=${encodeURIComponent(card.id)}`;
      const memoRes = await fetch(memoUrl, { headers: initData ? { "x-telegram-init-data": initData } : {} });
      const memoData = await memoRes.json().catch(() => ({}));
      if (!memoRes.ok || !memoData?.memo || !memoData?.operatorWallet || !memoData?.amountNano) throw new Error(memoData?.error ?? "Could not load power-up payment details.");
      await tonConnectUI.sendTransaction(paymentTx(String(memoData.operatorWallet), String(memoData.amountNano), String(memoData.memo)));
      showToast("Payment sent. Verifying power-up...");
      await new Promise((r) => setTimeout(r, 5000));
      const purchaseRes = await fetch(`${API_BASE}/gems/powerups/purchase`, { method: "POST", headers: { "Content-Type": "application/json", ...(initData ? { "x-telegram-init-data": initData } : {}) }, body: JSON.stringify({ telegramId: user.telegramId, gemType: card.id, senderAddress }) });
      const purchaseData = await purchaseRes.json().catch(() => ({}));
      if (!purchaseRes.ok) throw new Error(purchaseData?.error ?? "Power-up payment verification failed.");
      queryClient.invalidateQueries({ queryKey: getGetActiveGemsQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
      showToast(`${card.name} added`);
    } catch (err) { showToast(err instanceof Error ? err.message : "Power-up purchase failed."); }
    finally { setBuyingPowerup(null); }
  };

  const handleBuy = async (card: PowerCard) => {
    if (!user) return;
    if (activeTab === "boosts") { await handleBuyMinesPowerup(card); return; }
    if (card.vipOnly && !vip) return;
    if (confirming !== card.id) { setConfirming(card.id); return; }
    setConfirming(null);
    try {
      await purchaseMutation.mutateAsync({ data: { telegramId: user.telegramId, gemType: card.id as import("@workspace/api-client-react").PurchaseGemBodyGemType } });
      queryClient.invalidateQueries({ queryKey: getGetActiveGemsQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      await refreshUser();
      showToast(`${card.name} added`);
    } catch (err) { showToast(err instanceof Error ? err.message : "Purchase failed. Try again."); }
  };

  if (isLoading) return <PageLoader rows={5} />;
  if (isError) return <PageError message="Could not load shop" onRetry={refetch} />;

  return <div className="min-h-screen px-3 pt-3 pb-28 text-white bg-[#05070d]">
    <style>{`.shop-glass { background: linear-gradient(160deg, rgba(13,24,44,.82), rgba(6,8,16,.96)); border: 1px solid rgba(77,163,255,.24); box-shadow: 0 18px 55px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.06); backdrop-filter: blur(18px); } .shop-gold { border-color: rgba(255,215,0,.34); box-shadow: 0 20px 60px rgba(0,0,0,.46), 0 0 34px rgba(255,215,0,.10), inset 0 1px 0 rgba(255,255,255,.08); } .shop-purple { border-color: rgba(182,92,255,.48); box-shadow: 0 20px 70px rgba(134,59,255,.18), inset 0 1px 0 rgba(255,255,255,.08); } .shop-cyan { border-color: rgba(0,245,255,.34); box-shadow: 0 20px 65px rgba(0,245,255,.10), inset 0 1px 0 rgba(255,255,255,.07); }`}</style>
    <AnimatePresence>{toast && <motion.div initial={{ opacity: 0, y: -18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} className="fixed top-4 left-1/2 z-[80] -translate-x-1/2 rounded-2xl border border-[#FFD700]/35 bg-black/90 px-5 py-3 shadow-[0_0_30px_rgba(255,215,0,.22)]"><div className="flex items-center gap-2 font-mono text-xs font-black text-[#FFD700]"><CheckCircle size={15} />{toast}</div></motion.div>}</AnimatePresence>

    <section className="grid grid-cols-[1fr_auto] gap-2 items-center mb-3"><div className="flex items-center gap-3"><div className="h-12 w-12 rounded-full border border-[#FFD700]/45 bg-[#FFD700]/10 flex items-center justify-center shadow-[0_0_28px_rgba(255,215,0,.18)]"><span className="text-xl font-black text-[#FFD700]">K</span></div><div><h1 className="text-2xl font-black tracking-[0.22em] text-[#FFD700] leading-none">KOINARA</h1><p className="font-mono text-[10px] tracking-[0.26em] text-white/45 mt-1">CREATOR ARCADE</p></div></div><Link href="/wallet" className="rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/9 px-3 py-2 font-black text-[#FFD700] flex items-center gap-2"><Wallet size={16} /> Wallet</Link></section>
    <section className="grid grid-cols-[1fr_1fr] gap-2 mb-3"><div className="shop-glass rounded-2xl p-3"><div className="font-mono text-2xl font-black text-[#8BC3FF] tabular-nums">{(user?.tradeCredits ?? 0).toLocaleString()}</div><div className="font-mono text-[10px] text-white/45">Play Credits (TC)</div></div><div className="shop-glass shop-gold rounded-2xl p-3"><div className="font-mono text-2xl font-black text-[#FFD700] tabular-nums">{(user?.goldCoins ?? 0).toLocaleString()}</div><div className="font-mono text-[10px] text-white/45">Game Coins (GC)</div></div></section>

    <section className="shop-glass shop-cyan rounded-3xl p-4 mb-3"><div className="flex items-start gap-3"><Users size={34} className="text-[#00F5FF] shrink-0" /><div><div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#00F5FF]">How Koinara works</div><div className="text-lg font-black">CR is creator rewards. TC is play fuel.</div><p className="font-mono text-[10px] text-white/48 mt-1">Creator Rewards come from verified referral activity and approved content. Play Credits are for Mines and Arcade entertainment only.</p></div></div></section>

    <section className="shop-glass rounded-3xl p-4 mb-3 overflow-hidden relative" style={{ borderColor: "rgba(255,215,0,.34)" }}><div className="absolute -right-10 -top-12 h-44 w-44 rounded-full bg-[#FFD700]/16 blur-3xl" /><div className="relative z-10 flex items-start gap-3"><PremiumIcon tone="#FFD700"><Target size={26} className="text-[#FFD700]" /></PremiumIcon><div className="flex-1"><div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[#FFD700] mb-1">Live Arcade Game</div><h2 className="text-2xl font-black leading-tight">Dice is live</h2><p className="mt-1 font-mono text-[10px] leading-relaxed text-white/50">Fast over/under Dice rounds built for Play TC. Simple rules, server-side results, capped GC payouts, and no trading charts.</p><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-2"><div className="font-mono text-[8px] text-white/35">Game</div><div className="font-black text-[#FFD700]">Dice</div></div><div className="rounded-2xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/8 p-2"><div className="font-mono text-[8px] text-white/35">Uses</div><div className="font-black text-[#8BC3FF]">Play TC</div></div><div className="rounded-2xl border border-[#00F5A0]/20 bg-[#00F5A0]/8 p-2"><div className="font-mono text-[8px] text-white/35">Status</div><div className="font-black text-[#00F5A0]">Live</div></div></div><Link href="/dice" className="mt-3 flex h-11 items-center justify-center rounded-2xl bg-[#FFD700] font-black text-black shadow-[0_0_24px_rgba(255,215,0,.25)]">Play Dice</Link><p className="mt-3 font-mono text-[9px] leading-relaxed text-white/35">Dice is Arcade entertainment. CR stays tied to verified creator activity and approved content rewards.</p></div></div></section>

    <section className="shop-glass shop-purple rounded-3xl p-4 mb-3 overflow-hidden relative"><div className="grid grid-cols-[94px_1fr] gap-4 relative z-10"><div className="h-28 rounded-[28px] border border-[#B65CFF]/45 bg-gradient-to-br from-[#B65CFF]/35 to-[#19082f] flex flex-col items-center justify-center shadow-[0_0_45px_rgba(182,92,255,.28)]"><Crown size={38} className="text-[#E7C4FF] drop-shadow-[0_0_18px_rgba(231,196,255,.8)]" /><div className="font-black text-2xl text-[#E7C4FF] mt-1">VIP</div></div><div><div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[#D9A8FF] mb-1">VIP Creator</div><h2 className="text-2xl font-black leading-tight">More creator tools. More daily play.</h2><div className="text-2xl font-black text-[#D9A8FF] mt-2">$5.99 <span className="text-sm text-white/55 font-mono">/ month</span></div><Link href="/vip" className="mt-3 h-11 rounded-2xl bg-gradient-to-r from-[#8A35FF] to-[#E26BFF] flex items-center justify-center gap-2 font-black shadow-[0_0_30px_rgba(182,92,255,.35)]"><Crown size={16} /> Activate VIP</Link></div></div></section>

    <section className="shop-glass shop-gold rounded-3xl p-4 mb-3 overflow-hidden relative"><div className="absolute -left-10 -top-12 h-44 w-44 rounded-full bg-[#FFD700]/20 blur-3xl" /><div className="relative z-10 flex items-start gap-3"><PremiumIcon tone="#FFD700"><ShieldCheck size={26} className="text-[#FFD700]" /></PremiumIcon><div className="flex-1"><div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[#FFD700] mb-1">Arcade safety</div><h2 className="text-2xl font-black leading-tight">Play boosts, not income boosts</h2><p className="mt-1 font-mono text-[10px] leading-relaxed text-white/50">Spend GC or TON for in-game protection, status, and Mines tools. These do not increase withdrawal value, GC caps, or payout formulas.</p>{battleGemCount > 0 && <div className="mt-3 rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 px-3 py-2 font-mono text-[10px] font-black text-[#00F5A0]">{battleGemCount} Arcade power-up use{battleGemCount === 1 ? "" : "s"} active</div>}</div></div></section>

    <section className="rounded-3xl border border-[#B65CFF]/35 bg-gradient-to-r from-[#B65CFF]/14 via-[#0B1020] to-[#FFD700]/10 p-3 mb-3 flex items-center justify-between"><div className="flex items-center gap-3"><Gift size={25} className="text-[#D9A8FF]" /><div><div className="font-mono text-[10px] text-[#D9A8FF] tracking-[0.18em] uppercase">Important</div><div className="font-black">TC cannot be withdrawn</div><div className="font-mono text-[10px] text-white/45">TC is for gameplay. CR is the creator reward balance.</div></div></div><div className="rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/8 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/45">Safer</div><div className="font-mono text-sm font-black text-[#FFD700]">Clear</div></div></section>

    <section className="grid grid-cols-4 gap-1.5 mb-3">{([["tc", Coins, "Play TC"], ["powerups", ShieldCheck, "Arcade"], ["vip", Crown, "VIP"], ["boosts", Rocket, "Mines"]] as const).map(([tab, Icon, label]) => <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded-2xl border py-2.5 font-black text-xs flex items-center justify-center gap-1.5 ${activeTab === tab ? "border-[#4DA3FF] bg-[#4DA3FF]/14 text-white shadow-[0_0_22px_rgba(77,163,255,.18)]" : "border-white/10 bg-white/[0.03] text-white/42"}`}><Icon size={15} />{label}</button>)}</section>

    {activeTab === "tc" && <section className="space-y-2">{TC_PACKS.map((pack) => { const Icon = pack.icon; const busy = buyingPack === pack.id; return <motion.div key={pack.id} layout className="shop-glass rounded-3xl p-3 relative overflow-hidden" style={{ borderColor: `${pack.tone}55` }}>{pack.badge && <div className="absolute right-0 top-0 rounded-bl-2xl px-3 py-1 text-[9px] font-black" style={{ background: `${pack.tone}CC`, color: pack.tone === "#FFD700" ? "#090909" : "white" }}>{pack.badge}</div>}<div className="flex items-center gap-3"><PremiumIcon tone={pack.tone}><Icon size={26} style={{ color: pack.tone }} /></PremiumIcon><div className="flex-1 min-w-0"><div className="text-base font-black">{pack.name}</div><div className="font-mono text-2xl font-black" style={{ color: pack.tone }}>{pack.tc.toLocaleString()} TC</div><div className="font-mono text-[10px] text-white/45">{pack.desc}</div></div><div className="text-right"><div className="font-mono text-lg font-black text-white">{pack.price}</div><button onClick={() => handleBuyTcPack(pack)} disabled={!!buyingPack} className="mt-2 rounded-xl border border-[#FFD700]/30 bg-[#FFD700]/10 px-3 py-2 font-mono text-[10px] font-black text-[#FFD700] flex items-center gap-1 disabled:opacity-40"><Wallet size={12} />{busy ? "Verifying" : "Buy"}</button></div></div></motion.div>; })}<div className="rounded-2xl border border-[#FFD700]/20 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]/85 flex items-start gap-2"><Sparkles size={13} className="shrink-0 mt-0.5" />Play TC is for Mines, Arcade rounds, and app activity. It is not withdrawable.</div></section>}
    {activeTab === "vip" && <section className="shop-glass shop-purple rounded-3xl p-5 text-center"><Crown size={48} className="mx-auto text-[#D9A8FF] mb-3" /><h3 className="text-2xl font-black">VIP Creator</h3><p className="font-mono text-xs text-white/45 mt-2">Creator Pass included, VIP badge, higher activity limits, and more daily Arcade/Mines value. Earnings are performance-based and reviewed.</p><Link href="/vip" className="mt-5 h-13 rounded-2xl bg-gradient-to-r from-[#8A35FF] to-[#FFD700] text-black flex items-center justify-center font-black">Activate VIP</Link></section>}
    {(activeTab === "powerups" || activeTab === "boosts") && <section className="grid grid-cols-2 gap-2">{cards.map((card) => { const Icon = card.icon; const locked = !!card.vipOnly && !vip; const isMinesPowerup = activeTab === "boosts"; const isBuyingThis = buyingPowerup === card.id; const canAfford = card.cost === 0 || (user?.goldCoins ?? 0) >= card.cost; const confirm = confirming === card.id; return <motion.div key={card.id} layout className="shop-glass rounded-2xl p-3 relative overflow-hidden" style={{ borderColor: `${card.tone}44` }}>{card.badge && <div className="absolute right-0 top-0 rounded-bl-2xl px-3 py-1 text-[9px] font-black" style={{ background: `${card.tone}CC`, color: card.tone === "#FFD700" || card.tone === "#ffd700" ? "#090909" : "white" }}>{card.badge}</div>}<PremiumIcon tone={card.tone}><Icon size={26} style={{ color: card.tone }} /></PremiumIcon><h3 className="mt-3 text-base font-black leading-tight">{card.name}</h3><p className="mt-1 min-h-[44px] font-mono text-[10px] leading-relaxed text-white/48">{card.desc}</p><div className="mt-3 flex items-center justify-between gap-2"><div><div className="font-mono text-[10px] text-white/35">{card.uses}</div><div className="font-mono text-sm font-black text-[#FFD700]">{card.cost > 0 ? `${card.cost.toLocaleString()} GC` : "TON"}</div></div><button onClick={() => handleBuy(card)} disabled={locked || (!!buyingPowerup && !isBuyingThis) || (!canAfford && card.cost > 0) || purchaseMutation.isPending} className="rounded-xl border border-[#FFD700]/35 bg-[#FFD700]/10 px-3 py-2 font-black text-[#FFD700] disabled:opacity-35">{locked ? <Lock size={15} /> : isBuyingThis ? "Verifying" : isMinesPowerup ? "Pay TON" : confirm ? "Confirm" : "Buy"}</button></div></motion.div>; })}</section>}
    {activeGemCount > 0 && <div className="mt-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-xs text-[#FFD700]">Active inventory: {activeGemCount} power-up uses ready.</div>}
  </div>;
}

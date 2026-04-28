import { useMemo, useState, type ComponentType, type CSSProperties } from "react";
import { Link } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Bell,
  CheckCircle,
  Coins,
  Crown,
  Flame,
  Gem,
  Gift,
  Lock,
  Rocket,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Target,
  TrendingUp,
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
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { PageError, PageLoader } from "@/components/PageStatus";

type GemType =
  | "starter_boost"
  | "big_swing"
  | "streak_saver"
  | "mystery_box"
  | "daily_refill"
  | "double_or_nothing"
  | "hot_streak"
  | "double_down"
  | "precision_lock"
  | "comeback_king"
  | "revenge_shield"
  | "safe_reveal"
  | "gem_magnet"
  | "second_chance";

type ShopTab = "powerups" | "vip" | "boosts";

type PowerCard = {
  id: GemType;
  name: string;
  desc: string;
  cost: number;
  uses: string;
  icon: ComponentType<{ size?: number; className?: string; style?: CSSProperties }>;
  tone: string;
  badge?: string;
  vipOnly?: boolean;
};

const POWER_CARDS: PowerCard[] = [
  { id: "hot_streak", name: "Hot Streak", desc: "2x GC on next 3 winning trades.", cost: 5000, uses: "3 uses", icon: Flame, tone: "#ff7a1a", badge: "HOT" },
  { id: "double_down", name: "Double Down", desc: "Double your next trade reward.", cost: 4000, uses: "1 use", icon: Zap, tone: "#28b7ff" },
  { id: "precision_lock", name: "Precision Lock", desc: "Lock in a cleaner reward edge.", cost: 4500, uses: "1 use", icon: Target, tone: "#00f5a0" },
  { id: "starter_boost", name: "Starter Boost", desc: "+25% GC for your next 10 trades.", cost: 3500, uses: "10 trades", icon: TrendingUp, tone: "#4da3ff" },
  { id: "big_swing", name: "Big Swing", desc: "+50% GC on your next winning trade.", cost: 6000, uses: "1 use", icon: Rocket, tone: "#b65cff" },
  { id: "streak_saver", name: "Streak Saver", desc: "Protect your streak. One loss forgiven.", cost: 3000, uses: "1 use", icon: ShieldCheck, tone: "#00f5c8" },
];

const BOOST_CARDS: PowerCard[] = [
  { id: "revenge_shield", name: "Revenge Shield", desc: "Absorbs one mine hit.", cost: 0, uses: "0.20 TON", icon: ShieldCheck, tone: "#00f5a0", badge: "MINES" },
  { id: "safe_reveal", name: "Safe Reveal", desc: "Reveal one safe tile.", cost: 0, uses: "0.10 TON", icon: Target, tone: "#4da3ff", badge: "MINES" },
  { id: "gem_magnet", name: "Gem Magnet", desc: "Boost three safe reveals.", cost: 0, uses: "0.15 TON", icon: Gem, tone: "#b65cff", badge: "MINES" },
  { id: "second_chance", name: "Second Chance", desc: "Refund once after a bust.", cost: 0, uses: "0.25 TON", icon: Star, tone: "#ffd700", badge: "MINES" },
];

function PremiumIcon({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <div
      className="h-13 w-13 rounded-2xl flex items-center justify-center border relative overflow-hidden"
      style={{ borderColor: `${tone}66`, background: `${tone}18`, boxShadow: `0 0 28px ${tone}26` }}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/15 to-transparent" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export default function ShopPremium() {
  const { user } = useTelegram();
  const queryClient = useQueryClient();
  const vip = isVipActive(user);
  const [activeTab, setActiveTab] = useState<ShopTab>("powerups");
  const [confirming, setConfirming] = useState<GemType | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const purchaseMutation = usePurchaseGem();

  const { data: activeGems, isLoading, isError, refetch } = useGetActiveGems(user?.telegramId ?? "", {
    query: { enabled: !!user, queryKey: getGetActiveGemsQueryKey(user?.telegramId ?? "") },
  });

  const activeGemCount = useMemo(() => {
    if (!Array.isArray(activeGems)) return 0;
    return activeGems.reduce((sum, item) => sum + Math.max(0, item.usesRemaining ?? 0), 0);
  }, [activeGems]);

  const cards = activeTab === "boosts" ? BOOST_CARDS : POWER_CARDS;

  const handleBuy = async (card: PowerCard) => {
    if (!user) return;
    if (card.vipOnly && !vip) return;
    if (confirming !== card.id) {
      setConfirming(card.id);
      return;
    }
    setConfirming(null);
    try {
      await purchaseMutation.mutateAsync({
        data: { telegramId: user.telegramId, gemType: card.id as import("@workspace/api-client-react").PurchaseGemBodyGemType },
      });
      queryClient.invalidateQueries({ queryKey: getGetActiveGemsQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      setToast(`${card.name} added`);
      setTimeout(() => setToast(null), 2800);
    } catch {
      setToast("Purchase failed. Try again.");
      setTimeout(() => setToast(null), 2800);
    }
  };

  if (isLoading) return <PageLoader rows={5} />;
  if (isError) return <PageError message="Could not load shop" onRetry={refetch} />;

  return (
    <div className="min-h-screen px-3 pt-3 pb-28 text-white bg-[#05070d]">
      <style>{`
        .shop-glass { background: linear-gradient(160deg, rgba(13,24,44,.82), rgba(6,8,16,.96)); border: 1px solid rgba(77,163,255,.24); box-shadow: 0 18px 55px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.06); backdrop-filter: blur(18px); }
        .shop-gold { border-color: rgba(255,215,0,.34); box-shadow: 0 20px 60px rgba(0,0,0,.46), 0 0 34px rgba(255,215,0,.10), inset 0 1px 0 rgba(255,255,255,.08); }
        .shop-purple { border-color: rgba(182,92,255,.48); box-shadow: 0 20px 70px rgba(134,59,255,.18), inset 0 1px 0 rgba(255,255,255,.08); }
        .shop-cyan { border-color: rgba(0,245,255,.34); box-shadow: 0 20px 65px rgba(0,245,255,.10), inset 0 1px 0 rgba(255,255,255,.07); }
      `}</style>

      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: -18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -18 }} className="fixed top-4 left-1/2 z-[80] -translate-x-1/2 rounded-2xl border border-[#FFD700]/35 bg-black/90 px-5 py-3 shadow-[0_0_30px_rgba(255,215,0,.22)]">
            <div className="flex items-center gap-2 font-mono text-xs font-black text-[#FFD700]"><CheckCircle size={15} />{toast}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-full border border-[#FFD700]/45 bg-[#FFD700]/10 flex items-center justify-center shadow-[0_0_28px_rgba(255,215,0,.18)]">
            <span className="text-xl font-black text-[#FFD700]">K</span>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-[0.22em] text-[#FFD700] leading-none">KOINARA</h1>
            <p className="font-mono text-[10px] tracking-[0.26em] text-white/45 mt-1">ALPHA TERMINAL</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/wallet" className="rounded-2xl border border-[#B65CFF]/35 bg-[#B65CFF]/12 px-3 py-2 font-black text-[#D9A8FF] flex items-center gap-2 shadow-[0_0_22px_rgba(182,92,255,.16)]">
            <Crown size={16} /> VIP {vip ? "ON" : "2"} <ArrowRight size={13} />
          </Link>
          <button className="h-11 w-11 rounded-2xl border border-white/10 bg-white/[0.035] flex items-center justify-center relative">
            <Bell size={18} className="text-white/70" />
            <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[#4DA3FF] shadow-[0_0_10px_#4DA3FF]" />
          </button>
        </div>
      </section>

      <section className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-3">
        <div className="shop-glass rounded-2xl p-3">
          <div className="font-mono text-2xl font-black text-white tabular-nums">{(user?.tradeCredits ?? 0).toLocaleString()}</div>
          <div className="font-mono text-[10px] text-[#8BC3FF]">Trade Credits</div>
        </div>
        <div className="shop-glass shop-gold rounded-2xl p-3">
          <div className="font-mono text-2xl font-black text-[#FFD700] tabular-nums">{(user?.goldCoins ?? 0).toLocaleString()}</div>
          <div className="font-mono text-[10px] text-white/45">Game Coins</div>
        </div>
        <Link href="/wallet" className="shop-glass rounded-2xl w-14 flex items-center justify-center"><Wallet size={25} className="text-[#8BC3FF]" /></Link>
      </section>

      <section className="shop-glass shop-purple rounded-3xl p-4 mb-3 overflow-hidden relative">
        <div className="absolute -left-10 -top-12 h-44 w-44 rounded-full bg-[#B65CFF]/20 blur-3xl" />
        <div className="grid grid-cols-[112px_1fr] gap-4 relative z-10">
          <div className="h-32 rounded-[28px] border border-[#B65CFF]/45 bg-gradient-to-br from-[#B65CFF]/35 to-[#19082f] flex flex-col items-center justify-center shadow-[0_0_45px_rgba(182,92,255,.28)]">
            <Crown size={46} className="text-[#E7C4FF] drop-shadow-[0_0_18px_rgba(231,196,255,.8)]" />
            <div className="font-black text-3xl text-[#E7C4FF] mt-1">VIP</div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-[#D9A8FF] mb-2">VIP Membership</div>
            <h2 className="text-3xl font-black leading-tight">Trade. Earn. Keep More.</h2>
            <div className="text-3xl font-black text-[#D9A8FF] mt-3">$5.99 <span className="text-sm text-white/55 font-mono">/ month</span></div>
            <Link href="/wallet" className="mt-4 h-12 rounded-2xl bg-gradient-to-r from-[#8A35FF] to-[#E26BFF] flex items-center justify-center gap-2 font-black shadow-[0_0_30px_rgba(182,92,255,.35)]">
              <Crown size={18} /> Activate VIP
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-4 relative z-10">
          {[
            [TrendingUp, "Better Conversion", "Higher GC value"],
            [Zap, "Higher Caps", "Trade + Mines boost"],
            [ShieldCheck, "No Verify Fee", "Save $1.99 first cashout"],
          ].map(([Icon, title, sub]) => {
            const PerkIcon = Icon as typeof TrendingUp;
            return <div key={String(title)} className="rounded-2xl border border-white/10 bg-white/[0.045] p-2"><PerkIcon size={18} className="text-[#D9A8FF] mb-1" /><div className="text-[11px] font-black">{title as string}</div><div className="font-mono text-[9px] text-white/38">{sub as string}</div></div>;
          })}
        </div>
      </section>

      <section className="shop-glass shop-cyan rounded-3xl p-4 mb-3">
        <div className="grid grid-cols-[86px_1fr] gap-3 items-center">
          <div className="h-20 rounded-3xl bg-gradient-to-br from-[#00F5FF]/24 to-[#FFD700]/18 border border-[#00F5FF]/28 flex items-center justify-center">
            <Users size={42} className="text-[#00F5FF] drop-shadow-[0_0_16px_rgba(0,245,255,.55)]" />
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-[#00F5FF]">Earn more together</div>
            <div className="text-lg font-black"><span className="text-[#00F5FF]">20%</span> direct VIP commission + <span className="text-[#00F5FF]">5%</span> level 2</div>
            <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 items-center">
              <p className="font-mono text-[10px] text-white/52">Invite 1 VIP to waive your first withdrawal fee.</p>
              <Link href="/earn" className="rounded-xl border border-[#00F5FF]/35 bg-[#00F5FF]/10 px-3 py-2 text-xs font-black text-[#9AFBFF] flex items-center gap-1">Invite <ArrowRight size={12} /></Link>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-[#B65CFF]/35 bg-gradient-to-r from-[#B65CFF]/14 via-[#0B1020] to-[#FFD700]/10 p-3 mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-13 w-13 rounded-2xl border border-[#B65CFF]/35 bg-[#B65CFF]/12 flex items-center justify-center"><Gift size={25} className="text-[#D9A8FF]" /></div>
          <div><div className="font-mono text-[10px] text-[#D9A8FF] tracking-[0.18em] uppercase">Limited time offer</div><div className="font-black">Power up your trading edge!</div><div className="font-mono text-[10px] text-white/45">Up to 30% off select power-ups.</div></div>
        </div>
        <div className="rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/8 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/45">Ends in</div><div className="font-mono text-sm font-black text-[#FFD700]">15h 02m</div></div>
      </section>

      <section className="grid grid-cols-3 gap-2 mb-3">
        {([
          ["powerups", Zap, "Power-ups"],
          ["vip", Crown, "VIP"],
          ["boosts", Rocket, "Boosts"],
        ] as const).map(([tab, Icon, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded-2xl border py-3 font-black flex items-center justify-center gap-2 ${activeTab === tab ? "border-[#4DA3FF] bg-[#4DA3FF]/14 text-white shadow-[0_0_22px_rgba(77,163,255,.18)]" : "border-white/10 bg-white/[0.03] text-white/42"}`}>
            <Icon size={17} /> {label}
          </button>
        ))}
      </section>

      {activeTab === "vip" ? (
        <section className="shop-glass shop-purple rounded-3xl p-5 text-center">
          <Crown size={48} className="mx-auto text-[#D9A8FF] mb-3" />
          <h3 className="text-2xl font-black">VIP is your profit path</h3>
          <p className="font-mono text-xs text-white/45 mt-2">Better conversion, higher caps, and no first-withdrawal verification fee.</p>
          <Link href="/wallet" className="mt-5 h-13 rounded-2xl bg-gradient-to-r from-[#8A35FF] to-[#FFD700] text-black flex items-center justify-center font-black">Activate VIP</Link>
        </section>
      ) : (
        <section className="grid grid-cols-2 gap-2">
          {cards.map((card) => {
            const Icon = card.icon;
            const locked = !!card.vipOnly && !vip;
            const canAfford = card.cost === 0 || (user?.goldCoins ?? 0) >= card.cost;
            const confirm = confirming === card.id;
            return (
              <motion.div key={card.id} layout className="shop-glass rounded-2xl p-3 relative overflow-hidden" style={{ borderColor: `${card.tone}44` }}>
                {card.badge && <div className="absolute right-0 top-0 rounded-bl-2xl px-3 py-1 text-[9px] font-black" style={{ background: `${card.tone}CC`, color: card.tone === "#ffd700" ? "#090909" : "white" }}>{card.badge}</div>}
                <PremiumIcon tone={card.tone}><Icon size={28} style={{ color: card.tone }} /></PremiumIcon>
                <h3 className="mt-3 text-base font-black leading-tight">{card.name}</h3>
                <p className="mt-1 min-h-[34px] font-mono text-[10px] leading-relaxed text-white/48">{card.desc}</p>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div>
                    <div className="font-mono text-[10px] text-white/35">{card.uses}</div>
                    <div className="font-mono text-sm font-black text-[#FFD700]">{card.cost > 0 ? `${card.cost.toLocaleString()} GC` : "TON"}</div>
                  </div>
                  <button onClick={() => handleBuy(card)} disabled={locked || (!canAfford && card.cost > 0) || purchaseMutation.isPending} className="rounded-xl border border-[#FFD700]/35 bg-[#FFD700]/10 px-3 py-2 font-black text-[#FFD700] disabled:opacity-35">
                    {locked ? <Lock size={15} /> : confirm ? "Confirm" : "Buy"}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </section>
      )}

      {activeGemCount > 0 && <div className="mt-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-xs text-[#FFD700]">Active inventory: {activeGemCount} power-up uses ready.</div>}
    </div>
  );
}

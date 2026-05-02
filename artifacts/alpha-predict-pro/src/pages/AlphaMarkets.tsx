import { useCallback, useEffect, useMemo, useState, type ElementType } from "react";
import { ArrowDown, ArrowUp, Clock, Crown, Flame, Loader2, Lock, RefreshCw, ShieldCheck, Sparkles, Trophy, Zap } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

type AlphaMarket = {
  marketId: string;
  symbol: string;
  label: string;
  durationSec: number;
  question: string;
  openPrice: number;
  closePrice?: number | null;
  resultSide?: "yes" | "no" | null;
  status: "open" | "settled" | string;
  yesPoolTc: number;
  noPoolTc: number;
  totalPoolTc: number;
  yesPct: number;
  noPct: number;
  entryCount: number;
  startAt: string;
  endAt: string;
  multiplier: number;
};

type AlphaEntry = {
  id: number;
  marketId: string;
  side: "yes" | "no" | string;
  amountTc: number;
  openPrice: number;
  closePrice?: number | null;
  status: "open" | "won" | "lost" | string;
  payoutGc: number;
  alphaPoints?: number;
  powerUp?: string | null;
  durationSec: number;
  endAt: string;
  createdAt: string;
};

type MarketResponse = { markets?: AlphaMarket[]; amounts?: number[]; powerUps?: string[] };
type EntriesResponse = { entries?: AlphaEntry[] };

type Side = "yes" | "no";
type PowerUp = "none" | "streak_shield" | "double_xp" | "reward_boost";

const FALLBACK_AMOUNTS = [50, 100, 250, 500, 1000, 5000];
const POWER_UPS: Array<{ id: PowerUp; label: string; sub: string; safe: boolean; icon: ElementType }> = [
  { id: "none", label: "None", sub: "Pure prediction", safe: true, icon: Zap },
  { id: "streak_shield", label: "Shield", sub: "Strategy tag · no price change", safe: true, icon: ShieldCheck },
  { id: "double_xp", label: "2x XP", sub: "More Alpha Points", safe: true, icon: Sparkles },
  { id: "reward_boost", label: "+10%", sub: "Capped GC bonus", safe: true, icon: Flame },
];

function authHeaders(): HeadersInit {
  const initData = window.Telegram?.WebApp?.initData;
  return initData ? { "x-telegram-init-data": initData } : {};
}

function jsonHeaders(): HeadersInit {
  return { "Content-Type": "application/json", ...authHeaders() };
}

function formatPrice(value?: number | null): string {
  if (!value || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCountdown(endAt: string): string {
  const ms = Math.max(0, new Date(endAt).getTime() - Date.now());
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function durationName(durationSec: number): string {
  if (durationSec === 300) return "Quick";
  if (durationSec === 900) return "Main";
  return "Alpha";
}

function powerUpLabel(id?: string | null): string {
  if (!id || id === "none") return "No power-up";
  if (id === "streak_shield") return "Streak Shield";
  if (id === "double_xp") return "2x XP";
  if (id === "reward_boost") return "Reward Boost";
  return id;
}

export default function AlphaMarkets() {
  const { user, refreshUser } = useTelegram();
  const vip = isVipActive(user);
  const [markets, setMarkets] = useState<AlphaMarket[]>([]);
  const [amounts, setAmounts] = useState<number[]>(FALLBACK_AMOUNTS);
  const [entries, setEntries] = useState<AlphaEntry[]>([]);
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("yes");
  const [amount, setAmount] = useState(100);
  const [powerUp, setPowerUp] = useState<PowerUp>("none");
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.marketId === selectedMarketId) ?? markets[1] ?? markets[0],
    [markets, selectedMarketId],
  );

  const liveEntries = useMemo(() => entries.filter((entry) => entry.status === "open").slice(0, 4), [entries]);
  const settledEntries = useMemo(() => entries.filter((entry) => entry.status !== "open").slice(0, 6), [entries]);
  const maxAmount = vip ? 5000 : 1000;
  const projectedGc = selectedMarket ? Math.floor(amount * selectedMarket.multiplier) + (powerUp === "reward_boost" ? Math.min(250, Math.floor(amount * selectedMarket.multiplier * 0.1)) : 0) : 0;
  const projectedXp = Math.floor(amount * 0.6 * (powerUp === "double_xp" ? 2 : 1) * (vip ? 1.1 : 1));

  const load = useCallback(async () => {
    try {
      const marketRes = await fetch(`${API_BASE}/alpha-markets?ts=${Date.now()}`, { cache: "no-store" });
      const marketData = await marketRes.json().catch(() => ({})) as MarketResponse;
      if (marketRes.ok && Array.isArray(marketData.markets)) {
        setMarkets(marketData.markets);
        setAmounts(Array.isArray(marketData.amounts) ? marketData.amounts : FALLBACK_AMOUNTS);
        setSelectedMarketId((old) => old ?? marketData.markets?.[1]?.marketId ?? marketData.markets?.[0]?.marketId ?? null);
      }

      if (user?.telegramId) {
        const entryRes = await fetch(`${API_BASE}/alpha-markets/user/${encodeURIComponent(user.telegramId)}?ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" });
        const entryData = await entryRes.json().catch(() => ({})) as EntriesResponse;
        if (entryRes.ok && Array.isArray(entryData.entries)) setEntries(entryData.entries);
      }
    } catch {
      setNotice("Alpha Markets are connecting. Please retry in a moment.");
    } finally {
      setLoading(false);
    }
  }, [user?.telegramId]);

  useEffect(() => {
    void load();
    const marketTimer = window.setInterval(load, 15_000);
    const tickTimer = window.setInterval(() => setTick((x) => x + 1), 1_000);
    return () => { window.clearInterval(marketTimer); window.clearInterval(tickTimer); };
  }, [load]);

  const enterMarket = async () => {
    if (!user?.telegramId || !selectedMarket || entering) return;
    if (amount > maxAmount) {
      setNotice("VIP unlocks 5,000 TC market entries. Free users can enter up to 1,000 TC.");
      return;
    }
    try {
      setEntering(true);
      setNotice(null);
      const res = await fetch(`${API_BASE}/alpha-markets/entries`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ telegramId: user.telegramId, marketId: selectedMarket.marketId, side, amountTc: amount, powerUp }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Entry failed. Try again.");
      setNotice(`Entered ${selectedMarket.label}: ${side === "yes" ? "YES" : "NO"} with ${amount.toLocaleString()} TC.`);
      await refreshUser();
      await load();
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Entry failed. Try again.");
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally {
      setEntering(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#05070d] px-4 pt-6 text-white"><div className="rounded-3xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/7 p-5 font-mono text-xs text-[#8BC3FF]"><Loader2 size={16} className="mr-2 inline animate-spin"/>Loading Alpha Markets...</div></div>;
  }

  return <div className="min-h-screen bg-[#05070d] px-3 pb-28 pt-3 text-white">
    <style>{`.alpha-card{background:linear-gradient(160deg,rgba(15,24,42,.84),rgba(5,8,16,.94));border:1px solid rgba(77,163,255,.22);box-shadow:0 14px 40px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.055);backdrop-filter:blur(18px)}.alpha-gold{background:linear-gradient(135deg,#FFF5C2,#FFD700,#B8860B);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`}</style>

    <section className="alpha-card mb-3 rounded-3xl p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8BC3FF]">Koinara</div>
          <h1 className="alpha-gold mt-1 text-3xl font-black leading-none">Alpha Markets</h1>
        </div>
        <button onClick={() => void load()} className="rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/10 px-3 py-2 font-mono text-[10px] font-black text-[#8BC3FF]"><RefreshCw size={13} className="mr-1 inline"/>Sync</button>
      </div>
      <p className="font-mono text-[10px] leading-relaxed text-white/45">Polymarket-style BTC rounds, simplified for Koinara. Pick YES or NO with TC. Backend settles from verified market prices. No fake chart trading.</p>
    </section>

    {notice && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] text-[#FFD700]">{notice}</div>}

    <div className="mb-3 grid grid-cols-3 gap-2">
      {markets.map((market) => {
        const active = selectedMarket?.marketId === market.marketId;
        return <button key={market.marketId} onClick={() => setSelectedMarketId(market.marketId)} className={`rounded-2xl border p-3 text-left transition ${active ? "border-[#FFD700]/40 bg-[#FFD700]/12" : "border-white/10 bg-white/[0.025]"}`}>
          <div className={`font-mono text-[9px] font-black uppercase ${active ? "text-[#FFD700]" : "text-white/35"}`}>{durationName(market.durationSec)}</div>
          <div className="mt-1 font-black text-white">{market.label}</div>
          <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-white/45"><Clock size={10}/>{formatCountdown(market.endAt)}</div>
        </button>;
      })}
    </div>

    {selectedMarket && <section className="alpha-card mb-3 rounded-3xl p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/38">BTC Market</div>
          <h2 className="mt-1 text-xl font-black leading-tight text-white">{selectedMarket.question}</h2>
        </div>
        <div className="shrink-0 rounded-2xl border border-[#00E676]/25 bg-[#00E676]/8 px-3 py-2 text-center">
          <div className="font-mono text-[9px] text-white/35">Open</div>
          <div className="font-mono text-xs font-black text-[#00E676]">{formatPrice(selectedMarket.openPrice)}</div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <button onClick={() => setSide("yes")} className={`rounded-3xl border p-4 text-left ${side === "yes" ? "border-[#00E676]/45 bg-[#00E676]/13" : "border-white/10 bg-white/[0.025]"}`}>
          <div className="flex items-center gap-2"><ArrowUp className="text-[#00E676]" size={22}/><span className="text-2xl font-black text-[#00E676]">YES</span></div>
          <div className="mt-2 font-mono text-[10px] text-white/45">BTC closes higher</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full bg-[#00E676]" style={{ width: `${selectedMarket.yesPct}%` }}/></div>
          <div className="mt-1 font-mono text-[10px] text-white/38">{selectedMarket.yesPct}% · {selectedMarket.yesPoolTc.toLocaleString()} TC</div>
        </button>
        <button onClick={() => setSide("no")} className={`rounded-3xl border p-4 text-left ${side === "no" ? "border-[#FF4D6D]/45 bg-[#FF4D6D]/13" : "border-white/10 bg-white/[0.025]"}`}>
          <div className="flex items-center gap-2"><ArrowDown className="text-[#FF4D6D]" size={22}/><span className="text-2xl font-black text-[#FF4D6D]">NO</span></div>
          <div className="mt-2 font-mono text-[10px] text-white/45">BTC closes lower/equal</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full bg-[#FF4D6D]" style={{ width: `${selectedMarket.noPct}%` }}/></div>
          <div className="mt-1 font-mono text-[10px] text-white/38">{selectedMarket.noPct}% · {selectedMarket.noPoolTc.toLocaleString()} TC</div>
        </button>
      </div>

      <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3">
        <div className="mb-2 flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/38">Entry Amount</span><span className="font-mono text-[10px] text-white/35">{vip ? "VIP limit 5,000 TC" : "Free limit 1,000 TC"}</span></div>
        <div className="grid grid-cols-6 gap-1.5">{amounts.map((value) => <button key={value} onClick={() => setAmount(value)} disabled={value > maxAmount} className={`h-10 rounded-xl border font-mono text-[11px] font-black disabled:opacity-35 ${amount === value ? "border-[#FFD700]/45 bg-[#FFD700]/15 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value > maxAmount && <Lock size={9} className="mr-0.5 inline"/>}{value >= 1000 ? `${value / 1000}K` : value}</button>)}</div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {POWER_UPS.map((item) => {
          const Icon = item.icon;
          const active = powerUp === item.id;
          return <button key={item.id} onClick={() => setPowerUp(item.id)} className={`rounded-2xl border p-3 text-left ${active ? "border-[#8BC3FF]/45 bg-[#4DA3FF]/12" : "border-white/10 bg-white/[0.025]"}`}>
            <div className="flex items-center gap-2"><Icon size={14} className={active ? "text-[#8BC3FF]" : "text-white/35"}/><span className={`font-black ${active ? "text-[#8BC3FF]" : "text-white/60"}`}>{item.label}</span></div>
            <div className="mt-1 font-mono text-[9px] text-white/35">{item.sub}</div>
          </button>;
        })}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/35">If correct</div><div className="font-black text-[#FFD700]">+{projectedGc.toLocaleString()} GC</div></div>
        <div className="rounded-2xl border border-[#8BC3FF]/18 bg-[#4DA3FF]/7 p-3"><div className="font-mono text-[9px] text-white/35">Alpha Points</div><div className="font-black text-[#8BC3FF]">+{projectedXp.toLocaleString()}</div></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Closes in</div><div className="font-black text-white">{formatCountdown(selectedMarket.endAt)}</div></div>
      </div>

      <button onClick={enterMarket} disabled={entering || !user?.telegramId} className="w-full rounded-2xl bg-[#FFD700] py-4 font-black text-black disabled:opacity-45">{entering ? <><Loader2 size={16} className="mr-2 inline animate-spin"/>Entering...</> : `Enter ${side === "yes" ? "YES" : "NO"} · ${amount.toLocaleString()} TC`}</button>
      <p className="mt-2 text-center font-mono text-[9px] text-white/30">Backend-settled from verified BTC price · rewards capped by daily GC limits</p>
    </section>}

    <section className="alpha-card mb-3 rounded-3xl p-4">
      <div className="mb-3 flex items-center justify-between"><h3 className="text-lg font-black">Your Active Picks</h3><span className="font-mono text-[10px] text-white/35">{liveEntries.length} open</span></div>
      {liveEntries.length === 0 ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/35">Your open Alpha Market picks appear here.</div> : <div className="space-y-2">{liveEntries.map((entry) => <div key={entry.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className={`rounded-xl px-3 py-2 font-black ${entry.side === "yes" ? "bg-[#00E676]/10 text-[#00E676]" : "bg-[#FF4D6D]/10 text-[#FF4D6D]"}`}>{String(entry.side).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="font-mono text-xs font-black text-white">{durationName(entry.durationSec)} · {entry.amountTc.toLocaleString()} TC</div><div className="font-mono text-[9px] text-white/35">{powerUpLabel(entry.powerUp)} · closes in {formatCountdown(entry.endAt)}</div></div><Clock size={15} className="text-[#FFD700]"/></div>)}</div>}
    </section>

    <section className="alpha-card rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Trophy size={17} className="text-[#FFD700]"/><h3 className="text-lg font-black">Recent Results</h3>{vip && <span className="ml-auto rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-2 py-1 font-mono text-[9px] text-[#FFD700]"><Crown size={10} className="mr-1 inline"/>VIP</span>}</div>
      {settledEntries.length === 0 ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-center font-mono text-[10px] text-white/35">Settled results will show after markets close.</div> : <div className="space-y-2">{settledEntries.map((entry) => <div key={entry.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className={`h-10 w-10 rounded-2xl flex items-center justify-center font-black ${entry.status === "won" ? "bg-[#FFD700]/12 text-[#FFD700]" : "bg-[#FF4D6D]/10 text-[#FF8FA3]"}`}>{entry.status === "won" ? "W" : "L"}</div><div className="min-w-0 flex-1"><div className="font-mono text-xs font-black text-white">{entry.side.toUpperCase()} · {entry.amountTc.toLocaleString()} TC</div><div className="font-mono text-[9px] text-white/35">Open {formatPrice(entry.openPrice)} · Close {formatPrice(entry.closePrice)}</div></div><div className="text-right"><div className="font-mono text-xs font-black text-[#FFD700]">+{entry.payoutGc.toLocaleString()} GC</div><div className="font-mono text-[9px] text-[#8BC3FF]">+{entry.alphaPoints ?? 0} XP</div></div></div>)}</div>}
    </section>
  </div>;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Activity, ArrowDown, ArrowUp, CheckCircle, Clock, Crown, Loader2, RefreshCw, Shield, ShoppingBag, Swords, Trophy, Zap } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

const FREE_TRADE_STAKES = [100, 250, 500, 600];
const VIP_TRADE_STAKES = [100, 250, 500, 600, 1000, 2000];
const TRADE_TIMERS = [30, 60, 120];
const TRADE_MULTIPLIER: Record<number, number> = { 30: 1.25, 60: 1.35, 120: 1.45 };
const BATTLE_STAKES = [1000, 2000, 4000];
const BATTLE_DURATION_MS = 60_000;

type Direction = "up" | "down";
type Tab = "trade" | "battle" | "history";
type PredictionRow = { id: number; direction: string; amount: number; entryPrice: number; exitPrice?: number | null; status: string; payout?: number | null; duration?: number | null; multiplier?: number | null; createdAt: string; resolvedAt?: string | null; };
type BattleRow = { battleCode: string; status: string; stakeTc: number; startPrice?: number | null; endPrice?: number | null; gcPayout?: number | null; refundedTc?: number | null; winnerTelegramId?: string | null; viewerPrediction?: Direction | null; opponentPrediction?: Direction | null; startedAt?: string | null; expiresAt?: string | null; };
type BattleCap = { earned: number; cap: number; remaining: number; vip: boolean };

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
function formatSignedPrice(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatTimer(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function timeAgo(iso?: string | null): string {
  if (!iso) return "now";
  const min = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}
function dirLabel(dir?: string | null): string {
  if (dir === "up" || dir === "long") return "BTC UP";
  if (dir === "down" || dir === "short") return "BTC DOWN";
  return "???";
}
function dirApi(dir: Direction): "long" | "short" {
  return dir === "up" ? "long" : "short";
}
function movementFrom(row?: PredictionRow | null): number | null {
  if (!row?.entryPrice || !row.exitPrice) return null;
  return row.exitPrice - row.entryPrice;
}

export default function QuickTradeArena() {
  const { user, refreshUser } = useTelegram();
  const vip = isVipActive(user);
  const [tab, setTab] = useState<Tab>("trade");
  const [stake, setStake] = useState(100);
  const [timer, setTimer] = useState(60);
  const [price, setPrice] = useState<number | null>(null);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<number | null>(null);
  const [pendingTrade, setPendingTrade] = useState<PredictionRow | null>(null);
  const [lastResult, setLastResult] = useState<PredictionRow | null>(null);
  const [recentTrades, setRecentTrades] = useState<PredictionRow[]>([]);
  const [battleStake, setBattleStake] = useState(1000);
  const [battle, setBattle] = useState<BattleRow | null>(null);
  const [battleCap, setBattleCap] = useState<BattleCap | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const balanceTc = user?.tradeCredits ?? 0;
  const tradeStakes = vip ? VIP_TRADE_STAKES : FREE_TRADE_STAKES;
  const tradeCap = vip ? 10000 : 3000;
  const winGc = Math.floor(stake * (TRADE_MULTIPLIER[timer] + (vip ? 0.05 : 0)));
  const lowTc = balanceTc < stake;
  const tradeRemainingMs = pendingTrade ? new Date(pendingTrade.createdAt).getTime() + (pendingTrade.duration ?? 60) * 1000 - Date.now() : 0;
  const battleRemainingMs = battle?.startedAt ? new Date(battle.startedAt).getTime() + BATTLE_DURATION_MS - Date.now() : 0;
  const battleWaitingMs = battle?.expiresAt ? new Date(battle.expiresAt).getTime() - Date.now() : 0;
  const priceMove = price != null && lastPrice != null ? price - lastPrice : 0;
  const liveMove = pendingTrade?.entryPrice && price ? price - pendingTrade.entryPrice : null;
  const resultMove = movementFrom(lastResult);
  const priceAge = priceUpdatedAt ? Math.max(0, Math.floor((Date.now() - priceUpdatedAt) / 1000)) : null;

  const loadPrice = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/market/price?symbol=BTCUSDT&ts=${Date.now()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Number(data.price) > 0) {
        setPrice((prev) => {
          if (prev != null && Number(data.price) !== prev) setLastPrice(prev);
          return Number(data.price);
        });
        setPriceUpdatedAt(Date.now());
      }
    } catch {}
  }, []);

  const loadTrades = useCallback(async () => {
    if (!user?.telegramId) return;
    try {
      const res = await fetch(`${API_BASE}/predictions/user/${encodeURIComponent(user.telegramId)}?limit=12&ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => []);
      if (res.ok && Array.isArray(data)) {
        setRecentTrades(data);
        setPendingTrade(data.find((row: PredictionRow) => row.status === "pending") ?? null);
      }
    } catch {}
  }, [user?.telegramId]);

  const loadBattle = useCallback(async () => {
    if (!user?.telegramId) return;
    try {
      const res = await fetch(`${API_BASE}/battles/active?telegramId=${encodeURIComponent(user.telegramId)}&ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setBattle(data.battle ?? null); setBattleCap(data.cap ?? null); }
    } catch {}
  }, [user?.telegramId]);

  useEffect(() => { Promise.all([loadPrice(), loadTrades(), loadBattle()]).finally(() => setLoading(false)); }, [loadPrice, loadTrades, loadBattle]);
  useEffect(() => { const t = window.setInterval(() => setTick((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => { const t = window.setInterval(() => void loadPrice(), pendingTrade ? 1200 : 1800); return () => window.clearInterval(t); }, [loadPrice, pendingTrade?.id]);
  useEffect(() => { const t = window.setInterval(() => { void loadTrades(); void loadBattle(); }, pendingTrade || battle ? 2500 : 8000); return () => window.clearInterval(t); }, [pendingTrade?.id, battle?.battleCode, loadTrades, loadBattle]);

  const resultTone = useMemo(() => {
    if (!lastResult) return "";
    if (lastResult.status === "won") return "border-[#00F5A0]/35 bg-[#00F5A0]/10 text-[#00F5A0]";
    if (lastResult.status === "lost") return "border-[#FF4D6D]/35 bg-[#FF4D6D]/10 text-[#FF8FA3]";
    return "border-[#FFD700]/35 bg-[#FFD700]/10 text-[#FFD700]";
  }, [lastResult]);

  const startTrade = async (nextDirection: Direction) => {
    if (!user?.telegramId || busy) return;
    if (!price) { setNotice("Live BTC price is loading. Try again in a second."); return; }
    if (!tradeStakes.includes(stake)) { setNotice("Choose a valid Quick Trade stake."); return; }
    if (balanceTc < stake) { setNotice("Insufficient TC. Refill from Shop or Earn."); return; }
    setBusy(true); setNotice(null); setLastResult(null);
    try {
      const multiplier = TRADE_MULTIPLIER[timer] + (vip ? 0.05 : 0);
      const res = await fetch(`${API_BASE}/predictions`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ telegramId: user.telegramId, direction: dirApi(nextDirection), amount: stake, entryPrice: price, duration: timer, multiplier, symbol: "BTCUSDT" }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not start Quick Trade.");
      setPendingTrade(data); setRecentTrades((prev) => [data, ...prev.filter((row) => row.id !== data.id)].slice(0, 12));
      setNotice(`Entry locked by server at ${formatPrice(data.entryPrice)}. TC is locked until result.`);
      await refreshUser(); window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not start Quick Trade."); window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally { setBusy(false); }
  };

  const resolveTrade = async () => {
    if (!pendingTrade || busy) return;
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/predictions/${pendingTrade.id}/resolve`, { method: "POST", headers: { ...jsonHeaders(), "Idempotency-Key": `quick-trade-${pendingTrade.id}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not resolve trade yet.");
      setPendingTrade(null); setLastResult(data); setRecentTrades((prev) => [data, ...prev.filter((row) => row.id !== data.id)].slice(0, 12));
      setNotice(data.status === "won" ? `Result verified. You won ${Number(data.payout ?? 0).toLocaleString()} GC.` : "Result verified. Trade lost.");
      await refreshUser(); await loadTrades(); await loadPrice();
    } catch (err) { setNotice(err instanceof Error ? err.message : "Could not resolve trade yet."); } finally { setBusy(false); }
  };

  const startBattle = async (nextDirection: Direction) => {
    if (!user?.telegramId || busy) return;
    if (!vip) { setNotice("Battle Arena is for VIP/high-stake players. Quick Trade is open to everyone."); return; }
    if (balanceTc < battleStake) { setNotice("Insufficient TC for this Battle stake."); return; }
    setBusy(true); setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/battles/create`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ telegramId: user.telegramId, stakeTc: battleStake, prediction: nextDirection, battleType: "quick", symbol: "BTCUSDT" }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not start Battle.");
      setBattle(data.battle ?? null); setNotice(data.matched ? "Opponent found. Battle started." : "Waiting for opponent. TC is locked safely."); await refreshUser();
    } catch (err) { setNotice(err instanceof Error ? err.message : "Could not start Battle."); } finally { setBusy(false); }
  };

  const cancelBattle = async () => {
    if (!user?.telegramId || !battle?.battleCode || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/battles/cancel`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ telegramId: user.telegramId, battleCode: battle.battleCode }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Cancel failed.");
      setBattle(data.battle ?? null); setNotice("Battle cancelled. TC refunded."); await refreshUser();
    } catch (err) { setNotice(err instanceof Error ? err.message : "Cancel failed."); } finally { setBusy(false); }
  };

  if (loading) return <div className="min-h-screen bg-[#05070d] px-4 pt-5 text-white"><div className="rounded-3xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-5 font-mono text-xs text-[#FFD700]"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading Arena...</div></div>;

  return <div className="min-h-screen bg-[#05070d] px-3 pb-28 pt-3 text-white">
    <style>{`.arena-card{background:linear-gradient(160deg,rgba(17,18,28,.92),rgba(5,8,16,.97));border:1px solid rgba(255,215,0,.18);box-shadow:0 14px 40px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}.gold-title{background:linear-gradient(135deg,#FFF5C2,#FFD700,#B8860B);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.price-pulse{animation:pulse 1.8s ease-in-out infinite}`}</style>
    <section className="arena-card mb-3 rounded-3xl p-4"><div className="flex items-start justify-between gap-3"><div><div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8BC3FF]">Koinara</div><h1 className="gold-title mt-1 text-3xl font-black leading-none">Arena</h1><p className="mt-2 font-mono text-[10px] leading-relaxed text-white/45">Quick Trade is instant. Server locks the official BTC entry price.</p></div><div className="rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/10 px-3 py-2 text-right"><div className="font-mono text-[9px] text-white/35">TC Balance</div><div className="font-mono text-lg font-black text-[#8BC3FF]">{balanceTc.toLocaleString()}</div></div></div><div className="mt-4 grid grid-cols-3 gap-1.5">{(["trade", "battle", "history"] as const).map((value) => <button key={value} onClick={() => setTab(value)} className={`rounded-2xl border py-2.5 font-mono text-[11px] font-black uppercase ${tab === value ? "border-[#FFD700]/45 bg-[#FFD700]/14 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/42"}`}>{value === "trade" ? "Quick Trade" : value === "battle" ? "VIP Battle" : "History"}</button>)}</div></section>
    {notice && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] text-[#FFD700]">{notice}</div>}

    {tab === "trade" && <>
      <section className="arena-card mb-3 rounded-3xl p-4 text-center"><div className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/35"><Activity size={13} className="price-pulse text-[#00F5A0]"/>Server live BTC price</div><div className="mt-1 font-mono text-4xl font-black text-[#8BC3FF]">{formatPrice(price)}</div><div className="mt-2 flex items-center justify-center gap-2 font-mono text-[10px]"><span className={priceMove >= 0 ? "text-[#00F5A0]" : "text-[#FF8FA3]"}>{priceMove === 0 ? "Live" : formatSignedPrice(priceMove)}</span><span className="text-white/30">· updates every ~2s</span><span className="text-white/30">· {priceAge == null ? "syncing" : `${priceAge}s ago`}</span></div><button onClick={loadPrice} className="mt-2 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-1.5 font-mono text-[10px] text-white/45"><RefreshCw size={11} className="mr-1 inline"/>Refresh</button><p className="mt-2 font-mono text-[9px] leading-relaxed text-white/32">The display price moves live. Your real entry is locked by the server at the moment you tap UP/DOWN.</p></section>
      {lastResult && !pendingTrade && <section className={`mb-3 rounded-3xl border p-4 ${resultTone}`}><div className="flex items-center gap-2"><CheckCircle size={18}/><h2 className="text-xl font-black">{lastResult.status === "won" ? "Trade Won" : "Trade Lost"}</h2><span className="ml-auto font-mono text-xs">{lastResult.duration ?? timer}s</span></div><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">Entry</div><div className="font-black text-white">{formatPrice(lastResult.entryPrice)}</div></div><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">Exit</div><div className="font-black text-white">{formatPrice(lastResult.exitPrice)}</div></div><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">Movement</div><div className={Number(resultMove ?? 0) >= 0 ? "font-black text-[#00F5A0]" : "font-black text-[#FF8FA3]"}>{formatSignedPrice(resultMove)}</div></div><div className="rounded-2xl border border-white/10 bg-black/20 p-3"><div className="font-mono text-[9px] text-white/40">Result</div><div className="font-black text-white">{lastResult.status === "won" ? `+${Number(lastResult.payout ?? 0).toLocaleString()} GC` : `-${lastResult.amount.toLocaleString()} TC`}</div></div></div><button onClick={() => setLastResult(null)} className="mt-3 w-full rounded-2xl border border-white/10 bg-white/[0.04] py-2.5 font-mono text-xs font-black text-white/60">Start another trade</button></section>}
      {pendingTrade ? <section className="arena-card mb-3 rounded-3xl p-5 text-center"><div className="mx-auto mb-4 flex h-28 w-28 items-center justify-center rounded-full border-4 border-[#FFD700]/50 bg-[#FFD700]/10 shadow-[0_0_35px_rgba(255,215,0,.16)]"><div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">Time</div><div className="text-4xl font-black text-[#FFD700]">{Math.max(0, Math.ceil(tradeRemainingMs / 1000))}</div></div></div><h2 className="text-2xl font-black">Quick Trade Live</h2><p className="mt-2 font-mono text-xs text-white/45">{dirLabel(pendingTrade.direction)} · {pendingTrade.amount.toLocaleString()} TC</p><div className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#8BC3FF]/20 bg-[#4DA3FF]/8 p-3"><div className="font-mono text-[9px] text-white/35">Locked entry</div><div className="font-black text-[#8BC3FF]">{formatPrice(pendingTrade.entryPrice)}</div></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Live move</div><div className={Number(liveMove ?? 0) >= 0 ? "font-black text-[#00F5A0]" : "font-black text-[#FF8FA3]"}>{formatSignedPrice(liveMove)}</div></div></div>{tradeRemainingMs > 0 ? <p className="mt-3 font-mono text-[10px] text-white/35">Reveal result in {formatTimer(tradeRemainingMs)}</p> : <button onClick={resolveTrade} disabled={busy} className="mt-4 w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black disabled:opacity-50">{busy ? "Verifying price..." : "Reveal Verified Result"}</button>}<p className="mt-3 font-mono text-[9px] text-white/32">Exit price is fetched from the server when the timer ends.</p></section> : <section className="arena-card mb-3 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Zap size={18} className="text-[#FFD700]"/><h2 className="text-xl font-black">Quick Trade</h2><span className="ml-auto rounded-full border border-[#00F5A0]/25 bg-[#00F5A0]/8 px-2 py-1 font-mono text-[9px] text-[#00F5A0]">Instant</span></div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="mb-2 flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/38">Stake</span><span className="font-mono text-[10px] text-white/35">{vip ? "VIP unlocks 2K" : "VIP unlocks 1K/2K"}</span></div><div className="grid grid-cols-6 gap-1.5">{VIP_TRADE_STAKES.map((value) => <button key={value} onClick={() => setStake(value)} disabled={!tradeStakes.includes(value)} className={`h-10 rounded-xl border font-mono text-[11px] font-black disabled:opacity-30 ${stake === value ? "border-[#FFD700]/45 bg-[#FFD700]/15 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value >= 1000 ? `${value / 1000}K` : value}{!tradeStakes.includes(value) ? <Crown size={9} className="ml-0.5 inline"/> : null}</button>)}</div></div><div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/38"><Clock size={12}/>Timer</div><div className="grid grid-cols-3 gap-2">{TRADE_TIMERS.map((value) => <button key={value} onClick={() => setTimer(value)} className={`rounded-xl border py-2 font-mono text-xs font-black ${timer === value ? "border-[#8BC3FF]/45 bg-[#4DA3FF]/12 text-[#8BC3FF]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value}s</button>)}</div></div><div className="mb-3 grid grid-cols-2 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/35">Correct</div><div className="font-black text-[#FFD700]">+{winGc} GC</div></div><div className="rounded-2xl border border-[#4DA3FF]/18 bg-[#4DA3FF]/7 p-3"><div className="font-mono text-[9px] text-white/35">Daily cap</div><div className="font-black text-[#8BC3FF]">{tradeCap.toLocaleString()} GC</div></div></div>{lowTc && <div className="mb-3 rounded-2xl border border-[#FF4D6D]/25 bg-[#FF4D6D]/8 p-3"><div className="flex items-center gap-2 font-mono text-[10px] text-[#FF8FA3]"><ShoppingBag size={13}/>You need more TC for this stake.</div><Link href="/exchange"><button className="mt-2 w-full rounded-xl bg-[#FFD700] py-2 font-mono text-[10px] font-black text-black">Open Shop</button></Link></div>}<div className="grid grid-cols-2 gap-2"><button onClick={() => startTrade("up")} disabled={busy || lowTc || !price} className="h-20 rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 font-black text-[#00F5A0] disabled:opacity-50"><ArrowUp size={24} className="mx-auto mb-1"/>BTC GOES UP</button><button onClick={() => startTrade("down")} disabled={busy || lowTc || !price} className="h-20 rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 font-black text-[#FF4D6D] disabled:opacity-50"><ArrowDown size={24} className="mx-auto mb-1"/>BTC GOES DOWN</button></div><p className="mt-3 text-center font-mono text-[9px] text-white/30">TC is deducted before the round. Official entry/exit prices are server-locked for fairness.</p></section>}
    </>}

    {tab === "battle" && <section className="arena-card mb-3 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Swords size={18} className="text-[#FFD700]"/><h2 className="text-xl font-black">VIP Battle Arena</h2><span className="ml-auto rounded-full border border-[#FFD700]/25 bg-[#FFD700]/8 px-2 py-1 font-mono text-[9px] text-[#FFD700]">1v1</span></div>{!vip && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 p-3 font-mono text-[10px] text-[#FFD700]"><Crown size={13} className="mr-1 inline"/>Battle Arena is for serious VIP players. Quick Trade is open to everyone.<Link href="/vip"><button className="mt-2 w-full rounded-xl bg-[#FFD700] py-2 font-black text-black">View VIP</button></Link></div>}{battle ? <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-center"><div className="font-mono text-[10px] text-white/35">{battle.status === "waiting" ? "Waiting for opponent" : battle.status === "active" ? "Battle live" : "Battle status"}</div><div className="mt-1 text-2xl font-black text-[#FFD700]">{battle.status === "waiting" ? formatTimer(battleWaitingMs) : battle.status === "active" ? Math.max(0, Math.ceil(battleRemainingMs / 1000)) : battle.status.toUpperCase()}</div><p className="mt-2 font-mono text-xs text-white/45">Stake {battle.stakeTc.toLocaleString()} TC · {dirLabel(battle.viewerPrediction)}</p>{battle.status === "waiting" && <button onClick={cancelBattle} disabled={busy} className="mt-3 rounded-2xl border border-[#FF4D6D]/30 bg-[#FF4D6D]/10 px-5 py-3 font-mono text-xs font-black text-[#FF8FA3] disabled:opacity-50">Cancel & Refund</button>}</div> : <><div className="mb-3 grid grid-cols-3 gap-2">{BATTLE_STAKES.map((value) => <button key={value} onClick={() => setBattleStake(value)} disabled={!vip} className={`rounded-xl border py-3 font-mono text-xs font-black disabled:opacity-35 ${battleStake === value ? "border-[#FFD700]/45 bg-[#FFD700]/15 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value / 1000}K TC</button>)}</div><div className="grid grid-cols-2 gap-2"><button onClick={() => startBattle("up")} disabled={busy || !vip} className="h-18 rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 font-black text-[#00F5A0] disabled:opacity-40"><ArrowUp size={22} className="mx-auto mb-1"/>BATTLE UP</button><button onClick={() => startBattle("down")} disabled={busy || !vip} className="h-18 rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 font-black text-[#FF4D6D] disabled:opacity-40"><ArrowDown size={22} className="mx-auto mb-1"/>BATTLE DOWN</button></div><p className="mt-3 font-mono text-[9px] text-white/35">Battle uses 1v1 matchmaking, 60s timer, draw fee, and separate Battle GC daily cap: {(battleCap?.earned ?? 0).toLocaleString()} / {(battleCap?.cap ?? (vip ? 15000 : 5000)).toLocaleString()}.</p></>}</section>}

    {tab === "history" && <section className="arena-card mb-3 rounded-3xl p-4"><div className="mb-3 flex items-center gap-2"><Trophy size={17} className="text-[#FFD700]"/><h2 className="font-black">Recent Quick Trades</h2></div><div className="space-y-2">{recentTrades.length === 0 && <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-center font-mono text-xs text-white/35">No Quick Trades yet.</div>}{recentTrades.map((row) => { const move = movementFrom(row); return <div key={row.id} className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="flex items-center justify-between"><div><div className="font-black">{dirLabel(row.direction)}</div><div className="font-mono text-[10px] text-white/35">{row.amount} TC · {row.duration}s · {timeAgo(row.resolvedAt ?? row.createdAt)}</div><div className="mt-1 font-mono text-[9px] text-white/30">{formatPrice(row.entryPrice)} → {formatPrice(row.exitPrice)} · {formatSignedPrice(move)}</div></div><div className={`rounded-xl border px-3 py-2 text-right ${row.status === "won" ? "border-[#00F5A0]/25 bg-[#00F5A0]/8 text-[#00F5A0]" : row.status === "lost" ? "border-[#FF4D6D]/25 bg-[#FF4D6D]/8 text-[#FF8FA3]" : "border-[#FFD700]/25 bg-[#FFD700]/8 text-[#FFD700]"}`}><div className="font-mono text-[9px] uppercase">{row.status}</div><div className="font-black">{row.status === "won" ? `+${Number(row.payout ?? 0).toLocaleString()} GC` : row.status === "lost" ? `-${row.amount} TC` : "Live"}</div></div></div></div>; })}</div></section>}
    <section className="rounded-3xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/7 p-3 font-mono text-[10px] leading-relaxed text-white/45"><Shield size={13} className="mr-1 inline text-[#8BC3FF]"/>Quick Trade uses live display prices and server-locked entry/exit prices. TC is never withdrawable; only capped GC can be earned.</section>
  </div>;
}

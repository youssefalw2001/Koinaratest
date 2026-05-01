import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Lock, Loader2, ShieldCheck, Zap } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { getGetUserQueryKey, useCreatePrediction, useGetUserPredictions, useGetUserStats, useResolvePrediction } from "@workspace/api-client-react";
import { PageLoader } from "@/components/PageStatus";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";
import { useQueryClient } from "@tanstack/react-query";
import confetti from "canvas-confetti";

const API_BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/api`;
const TRADE_CAP_GC = 7000;
const BET_OPTIONS = [50, 100, 250, 500, 1000] as const;
const DURATIONS = [
  { seconds: 6 as const, multiplier: 1.5, label: "6s" },
  { seconds: 10 as const, multiplier: 1.65, label: "10s" },
  { seconds: 30 as const, multiplier: 1.75, label: "30s" },
  { seconds: 60 as const, multiplier: 1.85, label: "60s" },
] as const;
const PAIRS = [
  { id: "BTCUSDT", label: "BTC / USDT", coin: "B" },
  { id: "ETHUSDT", label: "ETH / USDT", coin: "E" },
  { id: "SOLUSDT", label: "SOL / USDT", coin: "S" },
  { id: "BNBUSDT", label: "BNB / USDT", coin: "N" },
  { id: "XRPUSDT", label: "XRP / USDT", coin: "X" },
] as const;

type Point = { t: number; p: number };
type TradeCapStatus = { effectiveCap?: number; earnedToday?: number; remaining?: number; capReached?: boolean; resetAt?: string };
type Props = { tradeCap?: TradeCapStatus | null; onTradeResolved?: () => void };
type ActiveRound = { id: number; direction: "long" | "short"; amount: number; entryPrice: number; duration?: number; createdAt?: string; openedAt?: number };
type FeedState = "connecting" | "live" | "retrying" | "unavailable";

function truncatePrice(raw: number): number { return Math.trunc(raw * 100) / 100; }
function formatPrice(value: number): string { return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function timeAgo(value?: string | null): string { const ms = value ? new Date(value).getTime() : Date.now(); const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (sec < 60) return `${sec}s`; if (sec < 3600) return `${Math.floor(sec / 60)}m`; return `${Math.floor(sec / 3600)}h`; }
function resetPassed(resetAt?: string): boolean { if (!resetAt) return false; const ms = new Date(resetAt).getTime(); return Number.isFinite(ms) && ms <= Date.now(); }
function roundStartMs(round: ActiveRound): number { const created = round.createdAt ? new Date(round.createdAt).getTime() : Number.NaN; return Number.isFinite(created) ? created : (round.openedAt ?? Date.now()); }
function remainingMs(round: ActiveRound): number { return Math.max(0, roundStartMs(round) + (round.duration ?? 60) * 1000 - Date.now()); }
function pathFor(points: Point[], width = 340, height = 178): string {
  if (points.length < 2) return "";
  const prices = points.map((p) => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(max - min, max * 0.00035, 0.01);
  return points.map((pt, i) => {
    const x = (i / Math.max(1, points.length - 1)) * width;
    const y = height - ((pt.p - min) / span) * (height - 18) - 9;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
async function fetchLivePrice(symbol: string): Promise<number | null> {
  const res = await fetch(`${API_BASE}/market/price?symbol=${encodeURIComponent(symbol)}&ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.source !== "live") return null;
  const raw = Number(data?.price);
  return Number.isFinite(raw) && raw > 0 ? truncatePrice(raw) : null;
}
async function fetchCandles(symbol: string): Promise<Point[]> {
  const res = await fetch(`${API_BASE}/market/klines/${encodeURIComponent(symbol)}?interval=1m&limit=42&ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((k: any[]) => ({ t: Math.floor(Number(k[0]) / 1000), p: truncatePrice(Number(k[4])) })).filter((p: Point) => Number.isFinite(p.p) && p.p > 0);
}
function errorMessage(err: unknown): string { const anyErr = err as any; return anyErr?.response?.data?.error || anyErr?.data?.error || anyErr?.message || "Trade failed. Please try again."; }

export default function TerminalTradeHotfix({ tradeCap, onTradeResolved }: Props) {
  const { user, isLoading, refreshUser } = useTelegram();
  const queryClient = useQueryClient();
  const createPrediction = useCreatePrediction();
  const resolvePrediction = useResolvePrediction();
  const [pairIndex, setPairIndex] = useState(0);
  const [showPairMenu, setShowPairMenu] = useState(false);
  const selectedPair = PAIRS[pairIndex] ?? PAIRS[0];
  const [durationIndex, setDurationIndex] = useState(3);
  const duration = DURATIONS[durationIndex] ?? DURATIONS[3];
  const [bet, setBet] = useState(100);
  const [price, setPrice] = useState(0);
  const [previousPrice, setPreviousPrice] = useState(0);
  const [firstPrice, setFirstPrice] = useState(0);
  const [points, setPoints] = useState<Point[]>([]);
  const [sentiment, setSentiment] = useState(58);
  const [feedState, setFeedState] = useState<FeedState>("connecting");
  const [activePrediction, setActivePrediction] = useState<ActiveRound | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [placingDirection, setPlacingDirection] = useState<"long" | "short" | null>(null);
  const [result, setResult] = useState<any>(null);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const latestPriceRef = useRef(0);
  const resolveInFlightRef = useRef<number | null>(null);

  const { data: recentPredictions } = useGetUserPredictions(user?.telegramId ?? "", { limit: 5 }, { query: { enabled: !!user, queryKey: ["predictions", user?.telegramId] } });
  const { data: userStats } = useGetUserStats(user?.telegramId ?? "", { query: { enabled: !!user, queryKey: ["user-stats", user?.telegramId] } });
  const recent = useMemo(() => Array.isArray(recentPredictions) ? recentPredictions : [], [recentPredictions]);
  const vip = isVipActive(user);
  const referralCount = (userStats as any)?.referralCount ?? 0;
  const is5kLocked = !vip && referralCount < 5;
  const capTotal = Math.max(1, tradeCap?.effectiveCap ?? TRADE_CAP_GC);
  const rawEarned = typeof tradeCap?.earnedToday === "number" ? tradeCap.earnedToday : (user?.dailyGcEarned ?? 0);
  const capEarned = resetPassed(tradeCap?.resetAt) && (tradeCap?.remaining ?? 0) >= capTotal ? 0 : Math.max(0, Math.min(rawEarned, capTotal));
  const capProgress = Math.min(100, (capEarned / capTotal) * 100);
  const multiplier = duration.multiplier + (vip ? 0.1 : 0);
  const projectedReward = Math.floor(bet * multiplier);
  const priceChange = firstPrice > 0 ? ((price - firstPrice) / firstPrice) * 100 : 0;
  const trendUp = price >= previousPrice;
  const chartPath = useMemo(() => pathFor(points), [points]);
  const activeDirection = activePrediction?.direction === "long" ? "UP" : "DOWN";
  const activeTone = activePrediction?.direction === "long" ? "#00E676" : "#FF4D6D";
  const liveReady = feedState === "live" && price > 0;

  const applyPrice = useCallback((raw: number) => {
    const next = truncatePrice(raw);
    const prev = latestPriceRef.current || next;
    setPreviousPrice(prev);
    setPrice(next);
    if (firstPrice <= 0) setFirstPrice(next);
    latestPriceRef.current = next;
    setPoints((old) => [...old.slice(-59), { t: Math.floor(Date.now() / 1000), p: next }]);
    setFeedState("live");
  }, [firstPrice]);

  const resolveActiveRound = useCallback(async (round: ActiveRound) => {
    if (!user || resolveInFlightRef.current === round.id) return;
    resolveInFlightRef.current = round.id;
    try {
      const entryPrice = round.entryPrice;
      const exitPrice = latestPriceRef.current || entryPrice;
      const resolved = await resolvePrediction.mutateAsync({ id: round.id, data: { exitPrice } });
      await refreshUser();
      onTradeResolved?.();
      queryClient.invalidateQueries({ queryKey: getGetUserQueryKey(user.telegramId) });
      queryClient.invalidateQueries({ queryKey: ["predictions", user.telegramId] });
      setResult({ ...resolved, exitPrice, entryPrice });
      setActivePrediction(null);
    } catch (err) {
      setTradeError(errorMessage(err));
    } finally {
      resolveInFlightRef.current = null;
      setPlacingDirection(null);
    }
  }, [onTradeResolved, queryClient, refreshUser, resolvePrediction, user]);

  useEffect(() => {
    let cancelled = false;
    setFeedState("connecting");
    setPrice(0); setPreviousPrice(0); setFirstPrice(0); setPoints([]); latestPriceRef.current = 0;
    const boot = async () => {
      const candles = await fetchCandles(selectedPair.id).catch(() => []);
      if (!cancelled && candles.length) setPoints(candles.slice(-42));
      const live = await fetchLivePrice(selectedPair.id).catch(() => null);
      if (cancelled) return;
      if (live) applyPrice(live); else setFeedState("unavailable");
    };
    boot();
    const timer = window.setInterval(async () => {
      const live = await fetchLivePrice(selectedPair.id).catch(() => null);
      if (cancelled) return;
      if (live) applyPrice(live); else setFeedState((old) => old === "connecting" ? "unavailable" : "retrying");
    }, 2000);
    const sentimentTimer = window.setInterval(() => setSentiment((old) => Math.min(78, Math.max(22, old + (Math.random() - 0.5) * 5))), 3000);
    return () => { cancelled = true; window.clearInterval(timer); window.clearInterval(sentimentTimer); };
  }, [selectedPair.id, applyPrice]);

  useEffect(() => {
    if (!activePrediction) return;
    const updateCountdown = () => setCountdown(Math.ceil(remainingMs(activePrediction) / 1000));
    updateCountdown();
    const countdownTimer = window.setInterval(updateCountdown, 250);
    const resolveTimer = window.setTimeout(() => void resolveActiveRound(activePrediction), remainingMs(activePrediction) + 250);
    return () => { window.clearInterval(countdownTimer); window.clearTimeout(resolveTimer); };
  }, [activePrediction, resolveActiveRound]);

  useEffect(() => {
    if (activePrediction || !recent.length) return;
    const pending = recent.find((item: any) => item?.status === "pending");
    if (!pending?.id || !pending?.direction || !pending?.entryPrice) return;
    setTradeError(null);
    setActivePrediction({ id: pending.id, direction: pending.direction, amount: pending.amount ?? bet, entryPrice: pending.entryPrice, duration: pending.duration ?? duration.seconds, createdAt: pending.createdAt, openedAt: pending.createdAt ? new Date(pending.createdAt).getTime() : Date.now() });
  }, [activePrediction, bet, duration.seconds, recent]);

  useEffect(() => { if (result?.status === "won") confetti({ particleCount: 100, spread: 68, origin: { y: 0.58 }, colors: ["#FFD700", "#00E676", "#63D3FF"] }); }, [result]);

  const handlePredict = useCallback(async (direction: "long" | "short") => {
    if (!user || activePrediction || placingDirection) return;
    if (!liveReady) { setTradeError("Live market price is unavailable. Trading is paused until the trusted feed reconnects."); return; }
    setTradeError(null);
    setPlacingDirection(direction);
    try {
      window?.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
      const entryPrice = latestPriceRef.current || price;
      const prediction = await createPrediction.mutateAsync({ data: { telegramId: user.telegramId, direction, amount: bet, entryPrice, duration: duration.seconds, multiplier, pair: selectedPair.id, symbol: selectedPair.id, useGems: [] } as any });
      setActivePrediction({ id: prediction.id, direction, amount: bet, entryPrice: prediction.entryPrice ?? entryPrice, duration: duration.seconds, createdAt: prediction.createdAt, openedAt: Date.now() });
    } catch (err) {
      setTradeError(errorMessage(err));
      setActivePrediction(null);
    } finally {
      setPlacingDirection(null);
    }
  }, [activePrediction, bet, createPrediction, duration.seconds, liveReady, multiplier, placingDirection, price, selectedPair.id, user]);

  if (isLoading) return <PageLoader rows={5} />;

  return <div className="min-h-screen pb-24 px-3 pt-2 bg-[#05070d] text-white">
    <style>{`.trade-glass{background:linear-gradient(160deg,rgba(15,24,42,.82),rgba(5,8,16,.93));border:1px solid rgba(77,163,255,.22);box-shadow:0 14px 38px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.055);backdrop-filter:blur(18px)}.soft-blue-glow{box-shadow:0 0 18px rgba(77,163,255,.2)}.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}`}</style>
    <section className="trade-glass rounded-2xl p-2.5 mb-2"><div className="flex items-center gap-2"><div className="h-9 w-9 rounded-xl bg-[#0A63FF]/12 border border-[#4DA3FF]/30 flex items-center justify-center soft-blue-glow"><Zap size={18} className="text-[#63D3FF]" /></div><div className="flex-1 min-w-0"><div className="flex items-center justify-between mb-1"><span className="font-mono text-[9px] tracking-[0.18em] uppercase text-white/48">Daily Trade Limit</span><span className="font-mono text-[9px] text-white/58">{capEarned.toLocaleString()} / {capTotal.toLocaleString()} · {capProgress.toFixed(0)}%</span></div><div className="h-1.5 rounded-full bg-white/8 overflow-hidden"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] via-[#4DA3FF] to-[#00F5FF]" style={{ width: `${capProgress}%` }} /></div></div></div></section>
    {!liveReady && <div className="mb-2 rounded-2xl border border-[#FFD700]/30 bg-[#FFD700]/8 px-3 py-2 font-mono text-[11px] text-[#FFD700]">Waiting for trusted live market price. Trades are paused until the feed is live.</div>}
    {tradeError && <div className="mb-2 rounded-2xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 px-3 py-2 font-mono text-[11px] text-[#FF8FA3]">{tradeError}</div>}
    <section className="trade-glass rounded-3xl overflow-hidden mb-2">
      <div className="flex items-center justify-between p-3 pb-1.5">
        <div className="relative min-w-0"><button onClick={() => setShowPairMenu((v) => !v)} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-2.5 py-2 max-w-[220px]"><div className="h-8 w-8 rounded-full bg-[#FFB000] flex items-center justify-center font-black text-black text-sm">{selectedPair.coin}</div><div className="text-left min-w-0"><div className="flex items-center gap-1.5"><span className="font-black text-white tracking-wide text-sm truncate">{selectedPair.label}</span><span className={`h-2 w-2 rounded-full ${feedState === "live" ? "bg-[#00E676] shadow-[0_0_10px_rgba(0,230,118,.85)]" : "bg-[#FFD700] shadow-[0_0_10px_rgba(255,215,0,.7)]"}`} /></div><div className="font-mono text-[10px] text-white/65 truncate">{price > 0 ? formatPrice(price) : "Waiting"} <span className={trendUp ? "text-[#00E676]" : "text-[#FF4D6D]"}>{priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%</span></div></div><ChevronDown size={13} className="text-white/40" /></button><AnimatePresence>{showPairMenu && <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="absolute z-30 mt-2 w-48 rounded-2xl border border-white/10 bg-[#101522] p-2 shadow-2xl">{PAIRS.map((pair, index) => <button key={pair.id} onClick={() => { setPairIndex(index); setShowPairMenu(false); setResult(null); setTradeError(null); }} className={`w-full rounded-xl px-3 py-2 text-left font-mono text-xs font-black ${index === pairIndex ? "bg-[#FFD700] text-black" : "text-white/55 hover:bg-white/8"}`}>{pair.label}</button>)}</motion.div>}</AnimatePresence></div>
        <div className="flex items-center gap-2"><div className="rounded-xl border border-white/10 bg-white/[0.04] px-2 py-1.5 font-mono text-[10px] text-white/65">1m</div><div className={`rounded-xl border px-2 py-1.5 font-mono text-[10px] ${feedState === "live" ? "border-[#00E676]/25 bg-[#00E676]/8 text-[#00E676]" : "border-[#FFD700]/25 bg-[#FFD700]/8 text-[#FFD700]"}`}>{feedState === "live" ? "LIVE" : "WAIT"}</div></div>
      </div>
      <div className="px-3 flex items-end justify-between gap-2"><div className={trendUp ? "text-[#00E676]" : "text-[#FF4D6D]"}><div className="text-[30px] leading-none font-black tracking-tight tabular-nums">{price > 0 ? `$${formatPrice(price)}` : "Live price unavailable"}</div></div><div className="text-right font-mono text-[10px] text-white/45"><div className="text-[#00E676]">Bulls {sentiment.toFixed(0)}%</div><div className="text-[#FF4D6D]">Bears {(100 - sentiment).toFixed(0)}%</div></div></div>
      <div className="relative h-[198px] px-3 mt-1 flex items-center justify-center">
        <svg viewBox="0 0 340 178" className="h-full w-full overflow-visible"><defs><linearGradient id="koinaraTradeLine" x1="0" x2="1"><stop offset="0%" stopColor="#00E676"/><stop offset="100%" stopColor="#4DA3FF"/></linearGradient></defs><path d={chartPath} fill="none" stroke="url(#koinaraTradeLine)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" filter="drop-shadow(0 0 8px rgba(77,163,255,.45))" />{points.length === 0 && <text x="170" y="92" textAnchor="middle" fill="rgba(255,255,255,.35)" fontSize="14">Waiting for live feed</text>}</svg>
        {activePrediction && <motion.div initial={{ opacity: 0, y: 8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="absolute left-5 top-3 rounded-2xl border bg-[#05070d]/88 px-3 py-2 shadow-[0_0_28px_rgba(255,215,0,.18)] backdrop-blur-xl" style={{ borderColor: `${activeTone}66` }}><div className="flex items-center gap-2"><ShieldCheck size={13} style={{ color: activeTone }} /><span className="font-mono text-[9px] font-black tracking-[0.18em] text-white/55">ENTRY LOCKED</span><span className="ml-auto rounded-full px-2 py-0.5 font-mono text-[9px] font-black" style={{ color: activeTone, backgroundColor: `${activeTone}18`, border: `1px solid ${activeTone}55` }}>{String(countdown).padStart(2, "0")}s</span></div><div className="mt-1 flex items-end gap-2"><span className="text-lg font-black" style={{ color: activeTone }}>{activeDirection}</span><span className="pb-0.5 font-mono text-[10px] font-black text-white/55">{activePrediction.amount} TC</span></div><div className="font-mono text-[13px] font-black text-[#FFD700]">${formatPrice(activePrediction.entryPrice ?? 0)}</div><div className="mt-0.5 font-mono text-[8px] text-white/35">Trusted market feed</div></motion.div>}
      </div>
      <div className="px-3 pb-3"><div className="h-1.5 rounded-full bg-white/8 overflow-hidden flex"><div className="h-full bg-[#00E676]" style={{ width: `${sentiment}%` }} /><div className="h-full bg-[#FF1744]" style={{ width: `${100 - sentiment}%` }} /></div></div>
    </section>
    <section className="grid grid-cols-[1fr_1fr] gap-2 mb-2"><button disabled={!!activePrediction || !!placingDirection || !liveReady} onClick={() => handlePredict("long")} className="h-16 rounded-2xl border border-[#00E676]/35 bg-[#00E676]/10 flex items-center justify-center gap-3 disabled:opacity-35"><span className="h-10 w-10 rounded-full border border-[#00E676]/45 bg-[#00E676]/12 flex items-center justify-center">{placingDirection === "long" ? <Loader2 size={20} className="animate-spin text-[#00E676]" /> : <ArrowUp size={22} className="text-[#00E676]" />}</span><span className="text-xl font-black text-[#00E676]">{placingDirection === "long" ? "PLACING" : "UP"}</span></button><button disabled={!!activePrediction || !!placingDirection || !liveReady} onClick={() => handlePredict("short")} className="h-16 rounded-2xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 flex items-center justify-center gap-3 disabled:opacity-35"><span className="text-xl font-black text-[#FF4D6D]">{placingDirection === "short" ? "PLACING" : "DOWN"}</span><span className="h-10 w-10 rounded-full border border-[#FF4D6D]/45 bg-[#FF4D6D]/12 flex items-center justify-center">{placingDirection === "short" ? <Loader2 size={20} className="animate-spin text-[#FF4D6D]" /> : <ArrowDown size={22} className="text-[#FF4D6D]" />}</span></button></section>
    <section className="trade-glass rounded-2xl p-2.5 mb-2"><div className="grid grid-cols-4 gap-1.5 mb-2">{DURATIONS.map((tier, index) => <button key={tier.seconds} onClick={() => setDurationIndex(index)} disabled={!!activePrediction || !!placingDirection} className={`h-9 rounded-xl border font-mono text-xs font-black disabled:opacity-35 ${index === durationIndex ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/35"}`}>{tier.label}</button>)}</div><div className="grid grid-cols-6 gap-1.5">{BET_OPTIONS.map((amount) => <button key={amount} disabled={!!activePrediction || !!placingDirection} onClick={() => setBet(amount)} className={`h-10 rounded-xl border font-mono text-xs font-black disabled:opacity-35 ${bet === amount ? "border-[#4DA3FF] bg-[#4DA3FF]/15 text-[#8BC3FF] soft-blue-glow" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{amount >= 1000 ? "1K" : amount}</button>)}<button disabled={is5kLocked || !!activePrediction || !!placingDirection} onClick={() => setBet(5000)} className={`h-10 rounded-xl border font-mono text-xs font-black flex items-center justify-center gap-1 disabled:opacity-35 ${bet === 5000 ? "border-[#FFD700] bg-[#FFD700]/15 text-[#FFD700]" : "border-[#FFD700]/35 bg-[#FFD700]/7 text-[#FFD700]/80"}`}>{is5kLocked && <Lock size={10} />}5K</button></div><div className="mt-2 grid grid-cols-[1fr_auto] gap-2 items-center"><div className="rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/7 px-3 py-2"><div className="font-mono text-[10px] text-white/40">Projected reward</div><div className="font-black text-[#FFD700] leading-tight">+{projectedReward} GC <span className="font-mono text-[10px] text-white/40">{multiplier.toFixed(2)}x</span></div></div><div className="rounded-xl border border-[#00E676]/20 bg-[#00E676]/7 px-3 py-2 min-w-[96px]"><div className="font-mono text-[10px] text-white/40">Chance</div><div className="font-black text-[#00E676] leading-tight">{Math.min(82, Math.max(48, 58 + (sentiment - 50) * 0.5 + (vip ? 4 : 0))).toFixed(0)}%</div></div></div>{is5kLocked && <div className="mt-2 flex items-center gap-2 rounded-xl border border-[#FFD700]/20 bg-[#FFD700]/7 px-3 py-2"><Lock size={13} className="text-[#FFD700]" /><span className="font-mono text-[10px] text-white/55"><span className="text-[#FFD700] font-black">5K locked:</span> VIP or 5 verified referrals.</span></div>}</section>
    {result && <section className={`rounded-2xl p-3 mb-2 border ${result.status === "won" ? "border-[#FFD700]/35 bg-[#FFD700]/10" : "border-[#FF4D6D]/35 bg-[#FF4D6D]/10"}`}><div className="flex items-center justify-between"><div className="font-black">{result.status === "won" ? "ROUND WON!" : "ROUND LOST"}</div><div className="font-mono text-sm text-white/60">{selectedPair.label}</div></div><div className="font-mono text-xs text-white/50 mt-1">Entry {formatPrice(result.entryPrice ?? 0)} · Exit {formatPrice(result.exitPrice ?? latestPriceRef.current)}</div></section>}
    <section className="trade-glass rounded-2xl p-3"><div className="font-mono text-[10px] tracking-[0.14em] uppercase text-white/48 mb-2">Past 5 trades</div><div className="flex gap-2 overflow-x-auto no-scrollbar">{recent.length === 0 ? <div className="font-mono text-xs text-white/35 py-4">Your trade history will appear here.</div> : recent.slice(0, 5).map((item: any) => <div key={item.id} className="min-w-[112px] rounded-2xl border border-white/10 bg-white/[0.035] p-3"><div className={`text-xs font-black ${item.status === "won" ? "text-[#FFD700]" : item.status === "pending" ? "text-[#8BC3FF]" : "text-[#FF4D6D]"}`}>{item.status === "won" ? "WIN" : item.status === "pending" ? "LIVE" : "LOSS"}</div><div className="font-mono text-sm font-black text-white mt-2">{item.status === "pending" ? `${item.amount?.toLocaleString?.() ?? item.amount} TC` : `${item.status === "won" ? "+" : "-"}${Math.abs(item.reward ?? item.amount ?? 0).toLocaleString()} GC`}</div><div className="font-mono text-[9px] text-white/28 mt-1">{timeAgo(item.createdAt)}</div></div>)}</div></section>
    <AnimatePresence>{activePrediction && <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed left-3 right-3 bottom-24 z-[80] mx-auto max-w-[396px] rounded-2xl border border-[#FFD700]/28 bg-[#070A12]/95 p-3 shadow-2xl"><div className="flex items-center justify-between"><div><div className="font-mono text-[10px] text-white/38 uppercase tracking-widest">Round active</div><div className="font-black text-[#FFD700]">{activeDirection} · {activePrediction.amount} TC</div></div><div className="font-mono text-2xl font-black text-white">00:{String(countdown).padStart(2, "0")}</div></div></motion.div>}</AnimatePresence>
  </div>;
}

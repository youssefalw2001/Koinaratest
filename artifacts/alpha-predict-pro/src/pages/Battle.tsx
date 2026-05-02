import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Clock, Crown, Loader2, RefreshCw, Shield, Swords, Trophy, Zap } from "lucide-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { isVipActive } from "@/lib/vipActive";

const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

const STAKES = [50, 100, 250, 500, 1000, 5000];
const BATTLE_DURATION_MS = 60_000;

type Prediction = "up" | "down";
type BattleStatus = "waiting" | "active" | "resolved" | "draw" | "cancelled" | "resolving";

type BattleRow = {
  battleCode: string;
  status: BattleStatus | string;
  battleType: "quick" | "private" | string;
  symbol: string;
  stakeTc: number;
  startPrice?: number | null;
  endPrice?: number | null;
  gcPayout?: number | null;
  refundedTc?: number | null;
  houseTcKept?: number | null;
  winnerTelegramId?: string | null;
  isDraw?: boolean | null;
  viewerPrediction?: Prediction | null;
  opponentPrediction?: Prediction | null;
  opponentMasked?: string | null;
  startedAt?: string | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string | null;
};

type BattleCap = { earned: number; cap: number; remaining: number; vip: boolean };
type RecentBattle = {
  battleCode: string;
  result: "win" | "loss" | "draw" | "cancelled";
  opponentMasked: string;
  stakeTc: number;
  gcEarned: number;
  refundedTc: number;
  startPrice?: number | null;
  endPrice?: number | null;
  resolvedAt: string;
};
type LeaderboardRow = { rank: number; name: string; totalGc: number };

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

function formatTimer(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function timeAgo(iso?: string | null): string {
  if (!iso) return "now";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function directionLabel(prediction?: string | null): string {
  return prediction === "up" ? "BTC UP" : prediction === "down" ? "BTC DOWN" : "???";
}

function resultTone(result: string): string {
  if (result === "win") return "text-[#00F5A0] bg-[#00F5A0]/10 border-[#00F5A0]/25";
  if (result === "draw") return "text-[#FFD700] bg-[#FFD700]/10 border-[#FFD700]/25";
  if (result === "cancelled") return "text-[#8BC3FF] bg-[#4DA3FF]/10 border-[#4DA3FF]/25";
  return "text-[#FF4D6D] bg-[#FF4D6D]/10 border-[#FF4D6D]/25";
}

export default function Battle() {
  const { user, refreshUser } = useTelegram();
  const vip = isVipActive(user);
  const [stake, setStake] = useState(100);
  const [prediction, setPrediction] = useState<Prediction>("up");
  const [battle, setBattle] = useState<BattleRow | null>(null);
  const [cap, setCap] = useState<BattleCap | null>(null);
  const [recent, setRecent] = useState<RecentBattle[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [waitingCount, setWaitingCount] = useState(0);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const maxStake = vip ? 5000 : 1000;
  const winGc = Math.floor(stake * 2 * 0.9);
  const drawFee = stake - Math.floor(stake * 0.95);
  const balanceTc = user?.tradeCredits ?? 0;
  const capPct = cap ? Math.min(100, Math.round((cap.earned / Math.max(1, cap.cap)) * 100)) : 0;

  const remainingMs = useMemo(() => {
    if (!battle) return 0;
    if (battle.status === "waiting" && battle.expiresAt) return new Date(battle.expiresAt).getTime() - Date.now();
    if (battle.status === "active" && battle.startedAt) return new Date(battle.startedAt).getTime() + BATTLE_DURATION_MS - Date.now();
    return 0;
  }, [battle, busy]);

  const movement = useMemo(() => {
    if (!battle?.startPrice || !btcPrice) return null;
    return btcPrice - battle.startPrice;
  }, [battle?.startPrice, btcPrice]);

  const loadWaiting = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/battles/waiting/${stake}?ts=${Date.now()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setWaitingCount(Number(data.waiting ?? 0));
    } catch {}
  }, [stake]);

  const loadRecent = useCallback(async () => {
    if (!user?.telegramId) return;
    try {
      const res = await fetch(`${API_BASE}/battles/recent?telegramId=${encodeURIComponent(user.telegramId)}&ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.battles)) setRecent(data.battles);
    } catch {}
  }, [user?.telegramId]);

  const loadLeaderboard = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/battles/leaderboard?ts=${Date.now()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.leaderboard)) setLeaderboard(data.leaderboard);
    } catch {}
  }, []);

  const loadActive = useCallback(async () => {
    if (!user?.telegramId) return;
    try {
      const res = await fetch(`${API_BASE}/battles/active?telegramId=${encodeURIComponent(user.telegramId)}&ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBattle(data.battle ?? null);
        setCap(data.cap ?? null);
      }
    } catch {
      setNotice("Battle arena is connecting. Please retry in a moment.");
    } finally {
      setLoading(false);
    }
  }, [user?.telegramId]);

  const loadPrice = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/market/price?symbol=BTCUSDT&ts=${Date.now()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.source === "live" && Number(data.price) > 0) setBtcPrice(Number(data.price));
    } catch {}
  }, []);

  useEffect(() => {
    void loadActive();
    void loadRecent();
    void loadLeaderboard();
  }, [loadActive, loadRecent, loadLeaderboard]);

  useEffect(() => { void loadWaiting(); }, [loadWaiting]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadWaiting();
      if (battle?.battleCode) {
        fetch(`${API_BASE}/battles/status/${encodeURIComponent(battle.battleCode)}?telegramId=${encodeURIComponent(user?.telegramId ?? "")}&ts=${Date.now()}`, { headers: authHeaders(), cache: "no-store" })
          .then((res) => res.json().then((data) => ({ res, data })).catch(() => ({ res, data: {} })))
          .then(({ res, data }) => {
            if (res.ok) {
              setBattle(data.battle ?? null);
              setCap(data.cap ?? null);
              if (["resolved", "draw", "cancelled"].includes(String(data.battle?.status))) {
                void refreshUser();
                void loadRecent();
                void loadLeaderboard();
              }
            }
          })
          .catch(() => {});
      } else {
        void loadActive();
      }
      if (battle?.status === "active") void loadPrice();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [battle?.battleCode, battle?.status, loadActive, loadLeaderboard, loadPrice, loadRecent, loadWaiting, refreshUser, user?.telegramId]);

  const startBattle = async (nextPrediction: Prediction) => {
    if (!user?.telegramId || busy) return;
    if (stake > maxStake) { setNotice("VIP unlocks 5,000 TC battles. Free users can battle up to 1,000 TC."); return; }
    if (balanceTc < stake) { setNotice("Insufficient TC. Claim Earn rewards or get TC from Shop."); return; }
    setBusy(true);
    setNotice(null);
    setPrediction(nextPrediction);
    try {
      const res = await fetch(`${API_BASE}/battles/create`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ telegramId: user.telegramId, stakeTc: stake, prediction: nextPrediction, battleType: "quick", symbol: "BTCUSDT" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Battle failed. Try again.");
      setBattle(data.battle ?? null);
      setNotice(data.matched ? "Opponent found. Battle started." : "Finding your opponent. TC is locked safely.");
      await refreshUser();
      await loadWaiting();
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Battle failed. Try again.");
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
    } finally {
      setBusy(false);
    }
  };

  const cancelBattle = async () => {
    if (!user?.telegramId || !battle?.battleCode || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/battles/cancel`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ telegramId: user.telegramId, battleCode: battle.battleCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Cancel failed.");
      setBattle(data.battle ?? null);
      setNotice("Battle cancelled. TC refunded.");
      await refreshUser();
      await loadRecent();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-[#05070d] px-4 pt-5 text-white"><div className="rounded-3xl border border-[#FFD700]/20 bg-[#FFD700]/7 p-5 font-mono text-xs text-[#FFD700]"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading Battle Arena...</div></div>;
  }

  return <div className="min-h-screen bg-[#05070d] px-3 pb-28 pt-3 text-white">
    <style>{`.battle-card{background:linear-gradient(160deg,rgba(17,18,28,.9),rgba(5,8,16,.96));border:1px solid rgba(255,215,0,.18);box-shadow:0 14px 40px rgba(0,0,0,.36),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(18px)}.gold-title{background:linear-gradient(135deg,#FFF5C2,#FFD700,#B8860B);-webkit-background-clip:text;-webkit-text-fill-color:transparent}`}</style>

    <section className="battle-card mb-3 rounded-3xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8BC3FF]">Koinara</div>
          <h1 className="gold-title mt-1 text-3xl font-black leading-none">Battle Arena</h1>
          <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/45">1v1 BTC battles. TC in first. Backend decides. GC payouts are capped.</p>
        </div>
        <div className="rounded-2xl border border-[#4DA3FF]/25 bg-[#4DA3FF]/10 px-3 py-2 text-right">
          <div className="font-mono text-[9px] text-white/35">TC Balance</div>
          <div className="font-mono text-lg font-black text-[#8BC3FF]">{balanceTc.toLocaleString()}</div>
        </div>
      </div>
      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.025] p-3">
        <div className="flex items-center justify-between font-mono text-[10px]"><span className="text-white/45">Battle GC today</span><span className={capPct >= 90 ? "text-[#FF4D6D]" : "text-[#FFD700]"}>{(cap?.earned ?? 0).toLocaleString()} / {(cap?.cap ?? (vip ? 15000 : 5000)).toLocaleString()}</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-gradient-to-r from-[#FFD700] to-[#FF4D6D]" style={{ width: `${capPct}%` }} /></div>
      </div>
    </section>

    {notice && <div className="mb-3 rounded-2xl border border-[#FFD700]/25 bg-[#FFD700]/8 px-3 py-2 font-mono text-[10px] text-[#FFD700]">{notice}</div>}

    {battle?.status === "waiting" && <section className="battle-card mb-3 rounded-3xl p-5 text-center">
      <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-full border border-[#FFD700]/25 bg-[#FFD700]/10 shadow-[0_0_30px_rgba(255,215,0,.15)]"><Loader2 size={34} className="animate-spin text-[#FFD700]" /></div>
      <h2 className="text-2xl font-black">Finding opponent...</h2>
      <p className="mt-2 font-mono text-xs text-white/45">Stake: {battle.stakeTc.toLocaleString()} TC locked · Code {battle.battleCode}</p>
      <p className="mt-1 font-mono text-[10px] text-white/30">Expires in {formatTimer(remainingMs)}</p>
      <button onClick={cancelBattle} disabled={busy} className="mt-4 rounded-2xl border border-[#FF4D6D]/30 bg-[#FF4D6D]/10 px-5 py-3 font-mono text-xs font-black text-[#FF8FA3] disabled:opacity-50">Cancel & Refund</button>
    </section>}

    {battle?.status === "active" && <section className="battle-card mb-3 rounded-3xl p-5 text-center">
      <div className="mx-auto mb-4 flex h-32 w-32 items-center justify-center rounded-full border-4 border-[#FFD700]/50 bg-[#FFD700]/10 shadow-[0_0_40px_rgba(255,215,0,.18)]"><div><div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">Time</div><div className="text-4xl font-black text-[#FFD700]">{Math.max(0, Math.ceil(remainingMs / 1000))}</div></div></div>
      <h2 className="text-2xl font-black">Battle Live</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 text-left">
        <div className="rounded-2xl border border-[#00F5A0]/25 bg-[#00F5A0]/8 p-3"><div className="font-mono text-[9px] text-white/35">You predicted</div><div className="font-black text-[#00F5A0]">{directionLabel(battle.viewerPrediction)}</div></div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Opponent</div><div className="font-black text-white/65">{directionLabel(battle.opponentPrediction)}</div></div>
      </div>
      <div className="mt-3 rounded-2xl border border-[#4DA3FF]/20 bg-[#4DA3FF]/7 p-3">
        <div className="font-mono text-[9px] text-white/35">BTC now</div>
        <div className="font-mono text-xl font-black text-[#8BC3FF]">{formatPrice(btcPrice ?? battle.startPrice)}</div>
        {movement !== null && <div className={`font-mono text-xs ${movement >= 0 ? "text-[#00F5A0]" : "text-[#FF4D6D]"}`}>{movement >= 0 ? "+" : ""}{formatPrice(Math.abs(movement)).replace("$", "$")} since start</div>}
      </div>
      {vip && !battle.opponentPrediction && <p className="mt-3 font-mono text-[10px] text-[#FFD700]">VIP reveal unlocks in the final 10 seconds.</p>}
    </section>}

    {battle && ["resolved", "draw", "cancelled"].includes(String(battle.status)) && <section className="battle-card mb-3 rounded-3xl p-5 text-center">
      <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-full border border-[#FFD700]/25 bg-[#FFD700]/10"><Trophy size={34} className="text-[#FFD700]" /></div>
      <h2 className="text-3xl font-black">{battle.status === "draw" ? "DRAW" : battle.status === "cancelled" ? "CANCELLED" : battle.gcPayout && battle.gcPayout > 0 ? "YOU WON" : "RESOLVED"}</h2>
      <p className="mt-2 font-mono text-sm text-[#FFD700]">{battle.status === "draw" ? `Refund: ${battle.refundedTc ?? 0} TC each` : battle.status === "cancelled" ? `Refunded: ${battle.refundedTc ?? 0} TC` : `Payout: ${(battle.gcPayout ?? 0).toLocaleString()} GC`}</p>
      <div className="mt-4 grid grid-cols-2 gap-2 text-left font-mono text-[10px] text-white/45"><div className="rounded-xl bg-white/[0.025] p-3">Start<br/><span className="text-white">{formatPrice(battle.startPrice)}</span></div><div className="rounded-xl bg-white/[0.025] p-3">End<br/><span className="text-white">{formatPrice(battle.endPrice)}</span></div></div>
      <button onClick={() => { setBattle(null); setNotice(null); void refreshUser(); void loadRecent(); }} className="mt-4 w-full rounded-2xl bg-[#FFD700] py-3 font-black text-black">New Battle</button>
    </section>}

    {!battle && <section className="battle-card mb-3 rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Swords size={18} className="text-[#FFD700]" /><h2 className="text-xl font-black">Quick Battle</h2><span className="ml-auto rounded-full border border-[#00F5A0]/25 bg-[#00F5A0]/8 px-2 py-1 font-mono text-[9px] text-[#00F5A0]">{waitingCount} waiting</span></div>
      <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3">
        <div className="mb-2 flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/38">Stake</span><span className="font-mono text-[10px] text-white/35">{vip ? "VIP max 5K" : "Free max 1K"}</span></div>
        <div className="grid grid-cols-6 gap-1.5">{STAKES.map((value) => <button key={value} onClick={() => setStake(value)} disabled={value > maxStake} className={`h-10 rounded-xl border font-mono text-[11px] font-black disabled:opacity-35 ${stake === value ? "border-[#FFD700]/45 bg-[#FFD700]/15 text-[#FFD700]" : "border-white/10 bg-white/[0.025] text-white/45"}`}>{value >= 1000 ? `${value / 1000}K` : value}{value > 1000 && !vip ? <Crown size={9} className="ml-0.5 inline"/> : null}</button>)}</div>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2"><div className="rounded-2xl border border-[#FFD700]/18 bg-[#FFD700]/7 p-3"><div className="font-mono text-[9px] text-white/35">Win</div><div className="font-black text-[#FFD700]">+{winGc} GC</div></div><div className="rounded-2xl border border-[#FF4D6D]/18 bg-[#FF4D6D]/7 p-3"><div className="font-mono text-[9px] text-white/35">Draw fee</div><div className="font-black text-[#FF8FA3]">-{drawFee} TC</div></div><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className="font-mono text-[9px] text-white/35">Rake</div><div className="font-black text-white">10%</div></div></div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => startBattle("up")} disabled={busy} className="h-20 rounded-3xl border border-[#00F5A0]/35 bg-[#00F5A0]/10 font-black text-[#00F5A0] disabled:opacity-50"><ArrowUp size={24} className="mx-auto mb-1"/>BTC GOES UP</button>
        <button onClick={() => startBattle("down")} disabled={busy} className="h-20 rounded-3xl border border-[#FF4D6D]/35 bg-[#FF4D6D]/10 font-black text-[#FF4D6D] disabled:opacity-50"><ArrowDown size={24} className="mx-auto mb-1"/>BTC GOES DOWN</button>
      </div>
      <p className="mt-3 text-center font-mono text-[9px] text-white/30">TC is deducted before battle. Winners receive GC only after backend settlement.</p>
    </section>}

    <section className="battle-card mb-3 rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Trophy size={16} className="text-[#FFD700]"/><h3 className="font-black">Top Battle Winners</h3></div>
      {leaderboard.length === 0 ? <div className="font-mono text-[10px] text-white/35">Leaderboard starts after battles resolve.</div> : <div className="space-y-2">{leaderboard.slice(0, 5).map((row) => <div key={`${row.rank}-${row.name}`} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.025] px-3 py-2"><span className="font-mono text-xs text-white/65">#{row.rank} {row.name}</span><span className="font-mono text-xs font-black text-[#FFD700]">{row.totalGc.toLocaleString()} GC</span></div>)}</div>}
    </section>

    <section className="battle-card rounded-3xl p-4">
      <div className="mb-3 flex items-center gap-2"><Shield size={16} className="text-[#8BC3FF]"/><h3 className="font-black">Recent Battles</h3></div>
      {recent.length === 0 ? <div className="font-mono text-[10px] text-white/35">Your battle history will appear here.</div> : <div className="space-y-2">{recent.map((row) => <div key={row.battleCode} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-3"><div className={`rounded-xl border px-2 py-1 font-mono text-[10px] font-black ${resultTone(row.result)}`}>{row.result.toUpperCase()}</div><div className="min-w-0 flex-1"><div className="font-mono text-xs text-white">{row.opponentMasked} · {row.stakeTc} TC</div><div className="font-mono text-[9px] text-white/35">{timeAgo(row.resolvedAt)} · {formatPrice(row.startPrice)} → {formatPrice(row.endPrice)}</div></div><div className="font-mono text-xs font-black text-[#FFD700]">{row.gcEarned > 0 ? `+${row.gcEarned} GC` : row.refundedTc > 0 ? `+${row.refundedTc} TC` : "—"}</div></div>)}</div>}
    </section>
  </div>;
}

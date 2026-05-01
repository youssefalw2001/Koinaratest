import { useState, useEffect } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Trophy, Crown, Rocket, CheckCircle } from "lucide-react";
import { useGetLeaderboard } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";
import { PageLoader, PageError } from "@/components/PageStatus";

type LeaderboardTab = "gold" | "creator";

type CreatorEntry = {
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  totalCrEarned: number;
  directReferralCount: number;
  rank: number;
};

function getCreatorBadge(count: number): { label: string; color: string } {
  if (count >= 100) return { label: "Elite",  color: "#00F5A0" };
  if (count >= 25)  return { label: "Gold",   color: "#FFD700" };
  if (count >= 10)  return { label: "Silver", color: "#C0C0C0" };
  if (count >= 3)   return { label: "Bronze", color: "#CD7F32" };
  return                    { label: "Starter", color: "rgba(255,255,255,0.35)" };
}

function maskUsername(username: string): string {
  return `@${username.slice(0, 4)}***`;
}

export default function Leaderboard() {
  const { user } = useTelegram();
  const [tab, setTab] = useState<LeaderboardTab>("gold");

  const { data: board, isLoading, isError, refetch } = useGetLeaderboard({ limit: 20 });

  const [creatorBoard, setCreatorBoard]     = useState<CreatorEntry[] | null>(null);
  const [creatorLoading, setCreatorLoading] = useState(false);
  const [creatorError, setCreatorError]     = useState(false);

  useEffect(() => {
    if (tab !== "creator") return;
    setCreatorLoading(true);
    setCreatorError(false);
    const base     = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
    const initData = window.Telegram?.WebApp?.initData ?? "";
    fetch(`${base}/api/creator/leaderboard`, {
      headers: {
        "Content-Type": "application/json",
        ...(initData ? { "x-telegram-init-data": initData } : {}),
      },
    })
      .then((r) => (r.ok ? (r.json() as Promise<CreatorEntry[]>) : Promise.reject()))
      .then((data) => setCreatorBoard(data))
      .catch(() => setCreatorError(true))
      .finally(() => setCreatorLoading(false));
  }, [tab, user?.telegramId]);

  const getRankStyle = (rank: number) => {
    if (rank === 1) return { color: "#FFD700", glow: "drop-shadow-[0_0_8px_#FFD700]" };
    if (rank === 2) return { color: "#C0C0C0", glow: "drop-shadow-[0_0_6px_#C0C0C0]" };
    if (rank === 3) return { color: "#CD7F32", glow: "drop-shadow-[0_0_6px_#CD7F32]" };
    return { color: "rgba(255,255,255,0.4)", glow: "" };
  };

  const currentUserInCreatorBoard = creatorBoard?.find((e) => e.telegramId === user?.telegramId);

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Trophy size={16} className="text-[#f5c518] drop-shadow-[0_0_6px_#f5c518]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Leaderboard</span>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setTab("gold")}
          className={`flex-1 py-2.5 rounded-xl font-mono text-xs font-black border transition-all flex flex-col items-center gap-1 ${
            tab === "gold"
              ? "border-[#FFD740]/60 text-[#FFD740] bg-[#FFD740]/8"
              : "border-white/10 text-white/30 bg-white/[0.02]"
          }`}
        >
          Gold Earners
          {tab === "gold" && (
            <span className="w-1 h-1 rounded-full bg-[#FFD740]" />
          )}
        </button>
        <button
          onClick={() => setTab("creator")}
          className={`flex-1 py-2.5 rounded-xl font-mono text-xs font-black border transition-all flex flex-col items-center gap-1 ${
            tab === "creator"
              ? "border-[#00F5A0]/60 text-[#00F5A0] bg-[#00F5A0]/8"
              : "border-white/10 text-white/30 bg-white/[0.02]"
          }`}
        >
          Creators
          {tab === "creator" && (
            <span className="w-1 h-1 rounded-full bg-[#00F5A0]" />
          )}
        </button>
      </div>

      {/* ── GOLD TAB ── */}
      {tab === "gold" && (
        <>
          <h1 className="font-mono text-2xl font-black text-white mb-1">Top Traders</h1>
          <p className="font-mono text-xs text-white/30 mb-6">Ranked by lifetime Gold Coins earned 🪙</p>

          {isLoading && <PageLoader rows={5} />}
          {isError && <PageError message="Could not load leaderboard" onRetry={refetch} />}

          <div className="space-y-2">
            {(board ?? []).map((entry, idx) => {
              const rankStyle    = getRankStyle(entry.rank);
              const isCurrentUser = user?.telegramId === entry.telegramId;
              return (
                <motion.div
                  key={entry.telegramId}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.04 }}
                  className={`flex items-center gap-3 p-3 rounded-xl border ${
                    isCurrentUser
                      ? "border-[#f5c518]/50 bg-[#f5c518]/8"
                      : "border-white/10 bg-white/[0.02]"
                  }`}
                  style={isCurrentUser ? { boxShadow: "0 0 15px rgba(245,197,24,0.15)" } : {}}
                >
                  <div className="w-8 text-center">
                    {entry.rank <= 3 ? (
                      <Trophy size={16} className={rankStyle.glow} style={{ color: rankStyle.color }} />
                    ) : (
                      <span className="font-mono text-sm font-bold" style={{ color: rankStyle.color }}>
                        {entry.rank}
                      </span>
                    )}
                  </div>

                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center font-mono text-sm font-black shrink-0"
                    style={{
                      background: entry.isVip ? "rgba(245,197,24,0.15)" : "rgba(0,240,255,0.1)",
                      border:     `1px solid ${entry.isVip ? "#f5c518" : "#00f0ff"}40`,
                      color:      entry.isVip ? "#f5c518" : "#00f0ff",
                    }}
                  >
                    {(entry.firstName ?? entry.username ?? entry.telegramId).charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-sm font-bold text-white truncate">
                        {entry.firstName ?? entry.username ?? `User_${entry.telegramId.slice(-4)}`}
                      </span>
                      {entry.isVip && <Crown size={10} className="text-[#f5c518] shrink-0" />}
                      {isCurrentUser && (
                        <span className="font-mono text-[9px] text-[#00f0ff] tracking-wider shrink-0">YOU</span>
                      )}
                    </div>
                    {entry.username && (
                      <span className="font-mono text-[10px] text-white/30">@{entry.username}</span>
                    )}
                  </div>

                  <div className="flex flex-col items-end shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="text-xs">🪙</span>
                      <span className="font-mono text-sm font-black text-[#f5c518]">
                        {(entry.totalGcEarned ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <span className="font-mono text-[9px] text-white/30">lifetime</span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}

      {/* ── CREATOR TAB ── */}
      {tab === "creator" && (
        <>
          {/* FOMO / Status Banner */}
          {user?.creatorPassPaid ? (
            <div
              className="p-4 rounded-2xl border mb-5"
              style={{
                borderColor: "rgba(0,245,160,0.4)",
                background:  "rgba(0,245,160,0.07)",
                boxShadow:   "0 0 20px rgba(0,245,160,0.1)",
              }}
            >
              <div className="flex items-center gap-3">
                <CheckCircle size={20} className="text-[#00F5A0] shrink-0" />
                <div>
                  <div className="font-mono text-sm font-black text-[#00F5A0]">You're a Creator</div>
                  {currentUserInCreatorBoard ? (
                    <div className="font-mono text-[10px] text-white/50 mt-0.5">
                      Rank #{currentUserInCreatorBoard.rank} · {currentUserInCreatorBoard.totalCrEarned.toLocaleString()} CR earned
                    </div>
                  ) : (
                    <div className="font-mono text-[10px] text-white/50 mt-0.5">
                      Keep sharing to climb the board
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div
              className="p-4 rounded-2xl border mb-5"
              style={{
                borderColor: "rgba(0,245,160,0.35)",
                background:  "linear-gradient(160deg, rgba(0,245,160,0.08), rgba(10,10,15,0.95))",
                boxShadow:   "0 0 25px rgba(0,245,160,0.12)",
              }}
            >
              <div className="flex items-start gap-3 mb-3">
                <Rocket size={20} className="text-[#00F5A0] shrink-0 mt-0.5" />
                <div>
                  <div className="font-mono text-sm font-black text-white">Join the Creator Leaderboard</div>
                  <div className="font-mono text-[10px] text-white/40 mt-0.5">
                    Top creators earned CR from real referral purchases this week.
                  </div>
                </div>
              </div>
              <div className="font-mono text-[10px] text-white/30 mb-3">
                Creator Pass — $0.99 / ₹82 one time
              </div>
              <Link
                to="/earn"
                className="flex items-center justify-center w-full py-2.5 rounded-xl font-mono text-sm font-black"
                style={{
                  background: "linear-gradient(135deg, #FFD740, #f5c518)",
                  color:      "#000",
                  boxShadow:  "0 0 15px rgba(255,215,64,0.3)",
                }}
              >
                Get Creator Pass →
              </Link>
            </div>
          )}

          {/* Loading */}
          {creatorLoading && <PageLoader rows={5} />}

          {/* Error / Empty — same empty state card */}
          {(creatorError || (!creatorLoading && creatorBoard !== null && creatorBoard.length === 0)) && (
            <div className="flex flex-col items-center py-12 gap-4">
              <Rocket size={36} className="text-[#00F5A0]/30" />
              <div className="text-center">
                <div className="font-mono text-sm text-white/40">Creator leaderboard is warming up</div>
                <div className="font-mono text-[10px] text-white/25 mt-1">
                  Be one of the first creators to join and appear here
                </div>
              </div>
              <Link
                to="/earn"
                className="font-mono text-xs font-black text-[#00F5A0] border border-[#00F5A0]/40 px-4 py-2 rounded-xl"
              >
                Get Creator Pass
              </Link>
            </div>
          )}

          {/* Creator list */}
          {!creatorLoading && !creatorError && creatorBoard && creatorBoard.length > 0 && (
            <>
              <div className="space-y-2 mb-3">
                {creatorBoard.map((entry, idx) => {
                  const isCurrentUser = user?.telegramId === entry.telegramId;
                  const badge         = getCreatorBadge(entry.directReferralCount);
                  const displayName   = entry.username
                    ? maskUsername(entry.username)
                    : `Creator #${entry.telegramId.slice(-4)}`;
                  const avatarChar    = (entry.username ?? entry.telegramId).charAt(
                    entry.username ? 0 : 0,
                  ).toUpperCase();

                  return (
                    <motion.div
                      key={entry.telegramId}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.04 }}
                      className="flex items-center gap-3 p-3 rounded-xl border"
                      style={
                        isCurrentUser
                          ? {
                              borderColor: "rgba(0,245,160,0.5)",
                              background:  "rgba(0,245,160,0.07)",
                              boxShadow:   "0 0 15px rgba(0,245,160,0.12)",
                            }
                          : {
                              borderColor: "rgba(255,255,255,0.08)",
                              background:  "rgba(255,255,255,0.02)",
                            }
                      }
                    >
                      {/* Rank */}
                      <div className="w-7 flex items-center justify-center shrink-0">
                        {entry.rank === 1 ? (
                          <span className="text-base leading-none">👑</span>
                        ) : entry.rank === 2 ? (
                          <div
                            className="w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-black"
                            style={{
                              background: "rgba(192,192,192,0.12)",
                              color:      "#C0C0C0",
                              border:     "1px solid rgba(192,192,192,0.3)",
                            }}
                          >
                            2
                          </div>
                        ) : entry.rank === 3 ? (
                          <div
                            className="w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-black"
                            style={{
                              background: "rgba(205,127,50,0.12)",
                              color:      "#CD7F32",
                              border:     "1px solid rgba(205,127,50,0.3)",
                            }}
                          >
                            3
                          </div>
                        ) : (
                          <span className="font-mono text-xs text-white/35 font-bold">{entry.rank}</span>
                        )}
                      </div>

                      {/* Avatar */}
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center font-mono text-sm font-black shrink-0"
                        style={{
                          background: "rgba(0,245,160,0.1)",
                          border:     "1px solid rgba(0,245,160,0.3)",
                          color:      "#00F5A0",
                        }}
                      >
                        {avatarChar}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="font-mono text-sm font-bold text-white truncate">
                            {displayName}
                          </span>
                          {isCurrentUser && (
                            <span className="font-mono text-[9px] text-[#00F5A0] tracking-wider shrink-0">YOU</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className="font-mono text-[9px] font-black px-1.5 py-0.5 rounded"
                            style={{
                              color:      badge.color,
                              background: `${badge.color}18`,
                              border:     `1px solid ${badge.color}30`,
                            }}
                          >
                            {badge.label}
                          </span>
                          <span className="font-mono text-[9px] text-white/25">from verified activity</span>
                        </div>
                        {isCurrentUser && (
                          <div className="font-mono text-[9px] text-[#00F5A0]/70 mt-0.5">
                            You · Rank #{entry.rank}
                          </div>
                        )}
                      </div>

                      {/* CR earned */}
                      <div className="flex flex-col items-end shrink-0">
                        <div className="font-mono text-sm font-black text-[#00F5A0]">
                          {entry.totalCrEarned.toLocaleString()} CR
                        </div>
                        <div className="font-mono text-[9px] text-white/30">
                          ≈ ${(entry.totalCrEarned / 1000).toFixed(2)}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {/* Current user's position if not in top list */}
              {!currentUserInCreatorBoard && user && (
                <div
                  className="flex items-center justify-between p-3 rounded-xl border border-[#00F5A0]/15 bg-[#00F5A0]/4 mb-4"
                >
                  <span className="font-mono text-[11px] text-white/40">Your position</span>
                  <span className="font-mono text-[11px] text-[#00F5A0]/60">Not ranked yet</span>
                </div>
              )}

              {/* Trust footer */}
              <div className="text-center space-y-0.5 pt-2">
                <p className="font-mono text-[9px] text-white/25">Leaderboard updates daily.</p>
                <p className="font-mono text-[9px] text-white/25">Only CR from verified purchases shown.</p>
                <p className="font-mono text-[9px] text-white/25">Estimated USD values based on 1,000 CR = $1.00.</p>
                <p className="font-mono text-[9px] text-white/25">Earnings are not guaranteed.</p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

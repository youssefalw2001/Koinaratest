import { motion } from "framer-motion";
import { Trophy, Crown } from "lucide-react";
import { useGetLeaderboard } from "@workspace/api-client-react";
import { useTelegram } from "@/lib/TelegramProvider";

export default function Leaderboard() {
  const { user } = useTelegram();
  const { data: board, isLoading } = useGetLeaderboard({ limit: 20 });

  const getRankStyle = (rank: number) => {
    if (rank === 1) return { color: "#FFD700", glow: "drop-shadow-[0_0_8px_#FFD700]" };
    if (rank === 2) return { color: "#C0C0C0", glow: "drop-shadow-[0_0_6px_#C0C0C0]" };
    if (rank === 3) return { color: "#CD7F32", glow: "drop-shadow-[0_0_6px_#CD7F32]" };
    return { color: "rgba(255,255,255,0.4)", glow: "" };
  };

  return (
    <div className="flex flex-col min-h-screen bg-black p-4 pb-8">
      <div className="flex items-center gap-2 mb-2">
        <Trophy size={16} className="text-[#f5c518] drop-shadow-[0_0_6px_#f5c518]" />
        <span className="font-mono text-xs text-white/60 tracking-widest uppercase">Gold Leaderboard</span>
      </div>
      <h1 className="font-mono text-2xl font-black text-white mb-1">Top Traders</h1>
      <p className="font-mono text-xs text-white/30 mb-6">Ranked by lifetime Gold Coins earned 🪙</p>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      )}

      <div className="space-y-2">
        {(board ?? []).map((entry, idx) => {
          const rankStyle = getRankStyle(entry.rank);
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
              {/* Rank */}
              <div className="w-8 text-center">
                {entry.rank <= 3 ? (
                  <Trophy size={16} className={rankStyle.glow} style={{ color: rankStyle.color }} />
                ) : (
                  <span className="font-mono text-sm font-bold" style={{ color: rankStyle.color }}>
                    {entry.rank}
                  </span>
                )}
              </div>

              {/* Avatar */}
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center font-mono text-sm font-black shrink-0"
                style={{
                  background: entry.isVip ? "rgba(245,197,24,0.15)" : "rgba(0,240,255,0.1)",
                  border: `1px solid ${entry.isVip ? "#f5c518" : "#00f0ff"}40`,
                  color: entry.isVip ? "#f5c518" : "#00f0ff",
                }}
              >
                {(entry.firstName ?? entry.username ?? entry.telegramId).charAt(0).toUpperCase()}
              </div>

              {/* Name */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-bold text-white truncate">
                    {entry.firstName ?? entry.username ?? `User_${entry.telegramId.slice(-4)}`}
                  </span>
                  {entry.isVip && <Crown size={10} className="text-[#f5c518] shrink-0" />}
                  {isCurrentUser && <span className="font-mono text-[9px] text-[#00f0ff] tracking-wider shrink-0">YOU</span>}
                </div>
                {entry.username && (
                  <span className="font-mono text-[10px] text-white/30">@{entry.username}</span>
                )}
              </div>

              {/* Total GC Earned (lifetime) */}
              <div className="flex flex-col items-end shrink-0">
                <div className="flex items-center gap-1">
                  <span className="text-xs">🪙</span>
                  <span className="font-mono text-sm font-black text-[#f5c518]">{(entry.totalGcEarned ?? 0).toLocaleString()}</span>
                </div>
                <span className="font-mono text-[9px] text-white/30">lifetime</span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

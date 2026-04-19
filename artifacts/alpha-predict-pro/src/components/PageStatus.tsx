import { AlertCircle, RefreshCw } from "lucide-react";

export function PageLoader({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-4 pt-6">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 rounded-xl bg-white/5 animate-pulse" />
      ))}
    </div>
  );
}

export function PageError({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <AlertCircle size={28} className="text-[#ff2d78] mb-3 drop-shadow-[0_0_8px_#ff2d78]" />
      <p className="font-mono text-sm text-white/60 mb-1">
        {message ?? "Failed to load data"}
      </p>
      <p className="font-mono text-[10px] text-white/30 mb-4">Check the console for details</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex items-center gap-2 font-mono text-xs text-[#00f0ff] border border-[#00f0ff]/30 px-4 py-2 rounded-xl hover:bg-[#00f0ff]/5 transition-colors"
        >
          <RefreshCw size={12} />
          Retry
        </button>
      )}
    </div>
  );
}

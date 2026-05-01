export const FREE_GC_PER_USD = 5000;
export const VIP_GC_PER_USD = 2500;

export function gcToUsd(gc: number, gcPerUsd = FREE_GC_PER_USD): number {
  if (!Number.isFinite(gc) || !Number.isFinite(gcPerUsd) || gcPerUsd <= 0) return 0;
  return gc / gcPerUsd;
}

export function formatGcUsd(gc: number, gcPerUsd = FREE_GC_PER_USD): string {
  const usd = gcToUsd(gc, gcPerUsd);
  if (!Number.isFinite(usd) || usd === 0) return "$0.000";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

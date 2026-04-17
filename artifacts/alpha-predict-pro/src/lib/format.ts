export const GC_PER_USD = 4000;

export function gcToUsd(gc: number): number {
  return gc / GC_PER_USD;
}

export function formatGcUsd(gc: number): string {
  const usd = gcToUsd(gc);
  if (usd === 0) return "$0.000";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

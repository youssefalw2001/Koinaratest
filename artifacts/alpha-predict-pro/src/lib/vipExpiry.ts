export function parseVipExpiry(raw?: string | null): Date | null {
  if (!raw) return null;
  const numericLike = /^\d+(\.\d+)?$/.test(raw.trim());
  if (!numericLike) {
    const direct = new Date(raw);
    if (Number.isFinite(direct.getTime())) return direct;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;

  // Some environments may serialize timestamps as seconds, others as ms.
  const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const fromNumeric = new Date(millis);
  if (!Number.isFinite(fromNumeric.getTime())) return null;
  return fromNumeric;
}

export function getVipCountdownLabel(raw?: string | null): string | null {
  const expiresAt = parseVipExpiry(raw);
  if (!expiresAt) return null;
  const diff = expiresAt.getTime() - Date.now();
  if (diff <= 0) return null;

  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

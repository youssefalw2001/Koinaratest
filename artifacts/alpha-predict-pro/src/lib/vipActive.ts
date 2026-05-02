/**
 * Frontend mirror of the backend isVipActive() helper.
 * VIP is active only when the user has an active paid VIP subscription.
 * Free automatic VIP trials are intentionally ignored/removed for launch economy safety.
 */
export function isVipActive(user: {
  isVip: boolean;
  vipExpiresAt?: string | null;
  vipTrialExpiresAt?: string | null;
} | null | undefined): boolean {
  if (!user) return false;
  const raw = user.vipExpiresAt;
  if (!user.isVip || !raw) return false;

  const direct = new Date(raw).getTime();
  if (Number.isFinite(direct)) return direct > Date.now();

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return false;
  const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  return Number.isFinite(millis) && millis > Date.now();
}

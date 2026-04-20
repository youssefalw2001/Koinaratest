/**
 * Frontend mirror of the backend isVipActive() helper.
 * Returns true if the user has an active paid VIP subscription OR an active Day-7 trial.
 */
export function isVipActive(user: {
  isVip: boolean;
  vipExpiresAt?: string | null;
  vipTrialExpiresAt?: string | null;
} | null | undefined): boolean {
  if (!user) return false;
  const now = Date.now();
  const parseDate = (raw?: string | null): number | null => {
    if (!raw) return null;
    const direct = new Date(raw).getTime();
    if (Number.isFinite(direct)) return direct;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(millis) ? millis : null;
  };
  const vipExpiry = parseDate(user.vipExpiresAt);
  const trialExpiry = parseDate(user.vipTrialExpiresAt);
  if (user.isVip && vipExpiry !== null && vipExpiry > now) return true;
  if (trialExpiry !== null && trialExpiry > now) return true;
  return false;
}

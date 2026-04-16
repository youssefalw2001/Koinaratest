/**
 * Shared VIP/trial eligibility helper — single source of truth.
 * VIP is active when either:
 *   - user.isVip is true AND vipExpiresAt is in the future (paid/TC plan), OR
 *   - vipTrialExpiresAt is set and still in the future (Day-7 trial)
 */
export function isVipActive(user: {
  isVip: boolean;
  vipExpiresAt: Date | null;
  vipTrialExpiresAt: Date | null;
}): boolean {
  const now = new Date();
  if (user.isVip && user.vipExpiresAt && user.vipExpiresAt > now) return true;
  if (user.vipTrialExpiresAt && user.vipTrialExpiresAt > now) return true;
  return false;
}

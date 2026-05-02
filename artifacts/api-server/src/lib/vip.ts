/**
 * Shared VIP eligibility helper — single source of truth.
 * VIP is active only when the user has an active paid VIP subscription.
 * Free automatic VIP trials are intentionally ignored/removed for launch economy safety.
 */
export function isVipActive(user: {
  isVip: boolean;
  vipExpiresAt: Date | null;
  vipTrialExpiresAt: Date | null;
}): boolean {
  const now = new Date();
  return !!(user.isVip && user.vipExpiresAt && user.vipExpiresAt > now);
}

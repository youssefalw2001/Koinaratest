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
  if (user.isVip && user.vipExpiresAt && new Date(user.vipExpiresAt).getTime() > now) return true;
  if (user.vipTrialExpiresAt && new Date(user.vipTrialExpiresAt).getTime() > now) return true;
  return false;
}

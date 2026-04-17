/**
 * Koinara API v0.2.0
 * Dual-currency economy: Trade Credits (TC) + Gold Coins (GC)
 */
export interface HealthStatus {
  status: string;
}

export interface ErrorResponse {
  error: string;
}

export interface RegisterUserBody {
  telegramId: string;
  /** @nullable */
  username?: string | null;
  /** @nullable */
  firstName?: string | null;
  /** @nullable */
  lastName?: string | null;
  /** @nullable */
  photoUrl?: string | null;
  /** @nullable */
  referredBy?: string | null;
}

export interface UpdateWalletBody {
  walletAddress: string;
}

export interface UpgradeToVipBody {
  plan: "weekly" | "monthly" | "tc";
  /** @nullable */
  txHash?: string | null;
}

export interface User {
  id: number;
  telegramId: string;
  /** @nullable */
  username?: string | null;
  /** @nullable */
  firstName?: string | null;
  /** @nullable */
  lastName?: string | null;
  /** @nullable */
  photoUrl?: string | null;
  tradeCredits: number;
  goldCoins: number;
  totalGcEarned: number;
  isVip: boolean;
  /** @nullable */
  vipExpiresAt?: string | null;
  /** @nullable */
  vipTrialExpiresAt?: string | null;
  hasVerified: boolean;
  /** @nullable */
  walletAddress?: string | null;
  /** @nullable */
  referredBy?: string | null;
  loginStreak: number;
  /** @nullable */
  lastLoginDate?: string | null;
  /** @nullable */
  registrationDate?: string | null;
  dailyGcEarned: number;
  /** @nullable */
  dailyGcDate?: string | null;
  weeklyWithdrawnGc: number;
  createdAt: string;
}

export interface UserStats {
  totalPredictions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalTcWagered: number;
  totalGcEarned: number;
  referralCount: number;
  rank: number;
}

export type CreatePredictionBodyDirection =
  (typeof CreatePredictionBodyDirection)[keyof typeof CreatePredictionBodyDirection];

export const CreatePredictionBodyDirection = {
  long: "long",
  short: "short",
} as const;

export interface CreatePredictionBody {
  telegramId: string;
  direction: CreatePredictionBodyDirection;
  amount: number;
  entryPrice: number;
}

export interface ResolvePredictionBody {
  exitPrice: number;
}

export type PredictionStatus =
  (typeof PredictionStatus)[keyof typeof PredictionStatus];

export const PredictionStatus = {
  pending: "pending",
  won: "won",
  lost: "lost",
} as const;

export interface Prediction {
  id: number;
  telegramId: string;
  direction: string;
  amount: number;
  entryPrice: number;
  /** @nullable */
  exitPrice?: number | null;
  status: PredictionStatus;
  /** @nullable */
  payout?: number | null;
  createdAt: string;
  /** @nullable */
  resolvedAt?: string | null;
}

export interface LeaderboardEntry {
  telegramId: string;
  /** @nullable */
  username?: string | null;
  /** @nullable */
  firstName?: string | null;
  goldCoins: number;
  totalGcEarned: number;
  isVip: boolean;
  rank: number;
}

export interface Quest {
  id: number;
  title: string;
  description: string;
  reward: number;
  externalUrl: string;
  category: string;
  isVipOnly: boolean;
  iconName: string;
}

export interface ClaimQuestBody {
  telegramId: string;
}

export interface ClaimQuestResponse {
  tcAwarded: number;
  newTcBalance: number;
  message: string;
}

export interface DailyRewardBody {
  telegramId: string;
}

export interface DailyRewardResponse {
  tcAwarded: number;
  newTcBalance: number;
  streak: number;
  message: string;
  isVipBonus: boolean;
}

export type GetUserPredictionsParams = {
  limit?: number;
};

export type GetLeaderboardParams = {
  limit?: number;
};

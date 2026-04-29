-- Koinara 5k-user readiness indexes
-- Safe to run manually in Railway Postgres.
-- Uses IF NOT EXISTS so rerunning is safe.

-- Core user lookups
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users (telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users (wallet_address);

-- Trade / prediction flow
CREATE INDEX IF NOT EXISTS idx_predictions_user_id_created_at ON predictions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_telegram_id_created_at ON predictions (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_status_created_at ON predictions (status, created_at DESC);

-- Withdrawal flow
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id_created_at ON withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id_created_at ON withdrawals (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status_created_at ON withdrawals (status, created_at DESC);

-- Payment / TON verification flow
CREATE INDEX IF NOT EXISTS idx_payments_telegram_id_created_at ON payments (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_tx_hash ON payments (tx_hash);
CREATE INDEX IF NOT EXISTS idx_payments_status_created_at ON payments (status, created_at DESC);

-- Referral flow
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals (referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_created_at ON referrals (created_at DESC);

-- Daily cap / anti-farm flow
CREATE INDEX IF NOT EXISTS idx_daily_trade_caps_user_date ON daily_trade_caps (user_id, day);
CREATE INDEX IF NOT EXISTS idx_daily_trade_caps_telegram_date ON daily_trade_caps (telegram_id, day);
CREATE INDEX IF NOT EXISTS idx_daily_mines_caps_user_date ON daily_mines_caps (user_id, day);
CREATE INDEX IF NOT EXISTS idx_daily_mines_caps_telegram_date ON daily_mines_caps (telegram_id, day);

-- Mines game history / active rounds
CREATE INDEX IF NOT EXISTS idx_mines_rounds_user_id_created_at ON mines_rounds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mines_rounds_telegram_id_created_at ON mines_rounds (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mines_rounds_status_created_at ON mines_rounds (status, created_at DESC);

-- Powerups / inventory
CREATE INDEX IF NOT EXISTS idx_user_gems_user_id ON user_gems (user_id);
CREATE INDEX IF NOT EXISTS idx_user_gems_telegram_id ON user_gems (telegram_id);
CREATE INDEX IF NOT EXISTS idx_user_gems_type_remaining ON user_gems (gem_type, uses_remaining);

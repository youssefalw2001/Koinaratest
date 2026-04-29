# Koinara 5k User Readiness Runbook

This checklist prepares Koinara for about 5,000 total users / a few hundred concurrent active users on low-cost infrastructure.

## 1. Database indexes

Run this in Railway Postgres before sending traffic:

```sql
\i sql/2026-04-30_5k_readiness_indexes.sql
```

If Railway UI does not support `\i`, copy/paste the SQL file contents directly into the Railway Postgres query editor.

## 2. Traffic target

This setup is intended for:

- 5,000 total users
- 500-1,500 daily active users
- 100-300 users active at once
- 20-80 trades per minute
- 1-10 payments per minute
- manual withdrawal review

It is not intended for 100,000 users active at the same time.

## 3. Endpoint pressure rules

Keep these flows lightweight:

- Trade chart prices should be client-side, not proxied through backend for every user.
- Trade cap status should poll every 30-60 seconds, not every second.
- Wallet withdrawal history should load only when Wallet/History opens.
- User profile should refresh after actions, not constantly.
- Mines state should poll only during an active round.

## 4. Manual launch watchlist

During the first launch window, watch:

- Railway CPU and memory
- Railway request errors
- Postgres CPU
- Postgres connection count
- slow queries
- payment verification failures
- duplicate tx hash attempts
- withdrawal queue size
- support messages

## 5. Abuse controls to keep

- One prediction create per user every 2 seconds minimum.
- One withdrawal request per user per minute.
- Payment verification should reject reused tx hashes.
- Withdrawal request should use idempotency key.
- Manual review for withdrawals.
- Keep free-user withdrawal verification requirement.

## 6. Launch sequence

1. Merge latest launch PRs.
2. Deploy frontend and backend.
3. Run database indexes.
4. Test one free user full path.
5. Test one VIP user full path.
6. Test cancelled payment grants nothing.
7. Invite 20-50 testers.
8. Complete 3-5 real withdrawals quickly.
9. Then scale to 500-1,000 users.
10. If stable, scale toward 5,000.

## 7. Rollback triggers

Pause public invites if any of these happen:

- TON payment credits without confirmed transaction.
- Duplicate tx hash grants repeat rewards.
- Withdrawal can be submitted without deduction/verification.
- Trade cap fails open and allows unlimited GC farming.
- Postgres connection count stays near max.
- Railway returns repeated 5xx errors.

## 8. Minimum success criteria

Koinara is ready for the next launch step when:

- 50+ users can open the app without errors.
- 10+ real payments complete correctly.
- 3+ withdrawals are processed correctly.
- No duplicate payment exploit works.
- No route refresh 404 happens inside Telegram.
- Trade/Mines caps display correctly after reset.

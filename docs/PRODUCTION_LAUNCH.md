# Koinara Production Launch Guide

This guide turns the current test build into the live public Telegram Mini App.

## Current decision

Use `WalletSimplified` as the official wallet for launch.

Why:
- It clearly separates TC, GC, and CR.
- It already contains GC withdrawal and CR withdrawal.
- It avoids maintaining multiple wallet versions before launch.

## Currency rules

- TC = Trade Credits. Blue play currency. Not withdrawable directly.
- GC = Gold Coins. Gold gameplay earnings. Withdrawable through gameplay withdrawal.
- CR = Creator Credits. Green creator/referral/content earnings. Withdrawable separately.
- 1,000 CR = $1.00 USDT.
- CR minimum withdrawal = 1,000 CR.
- CR withdrawal fee = 10%.
- Creator Pass is required for CR withdrawal.

## Pre-launch rule

Do not run public creator marketing until these commands pass:

```bash
pnpm install
pnpm run typecheck
pnpm run build
```

## Backend deployment

Deploy `artifacts/api-server` to Railway, Render, Fly.io, or another Node host.

Backend commands:

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

Required backend environment variables:

```text
NODE_ENV=production
PORT=3003
DATABASE_URL=postgresql://...
TELEGRAM_BOT_TOKEN=...
KOINARA_TON_WALLET=...
OWNER_TELEGRAM_ID=...
```

Optional if enabled in production:

```text
REDIS_URL=...
```

After backend deploy, test:

```text
https://YOUR_API_URL/api/health
```

## Frontend deployment through GitHub Actions

A workflow has been added:

```text
.github/workflows/deploy-frontend-pages.yml
```

Before running it:

1. Go to GitHub repository settings.
2. Open Settings > Secrets and variables > Actions.
3. Add repository secret:

```text
KOINARA_TON_WALLET=your production TON wallet
```

4. Go to Settings > Pages.
5. Set source to GitHub Actions.

Then run:

1. GitHub > Actions.
2. Select `Deploy Koinara Frontend to GitHub Pages`.
3. Click `Run workflow`.
4. Enter:

For GitHub Pages repo URL:

```text
api_url=https://YOUR_API_URL
base_path=/Koinaratest/
```

For a custom domain:

```text
api_url=https://YOUR_API_URL
base_path=/
```

The workflow builds `artifacts/alpha-predict-pro` and deploys `artifacts/alpha-predict-pro/dist/public` to GitHub Pages.

## Telegram BotFather setup

In BotFather:

1. Open your Koinara bot.
2. Open Bot Settings.
3. Set Menu Button / Web App URL to the live frontend URL.
4. Use the GitHub Pages URL or your custom domain.

Example:

```text
https://youssefalw2001.github.io/Koinaratest/
```

## Payment launch status

Production-safe now:

- Creator Pass TON payment verification.
- Duplicate Creator Pass tx protection.
- Creator Pass activates CR dashboard after verified TON payment.
- Stars Creator Pass activation is disabled until real invoice verification exists.

Still not enabled:

- Telegram Stars Creator Pass purchase.
- VIP renewal commission automation.

## Production smoke test

Run this before public launch:

1. Open live Telegram Mini App.
2. Register fresh user.
3. Visit Trade, Mines, Earn, Creator, Shop, Wallet.
4. Refresh every route.
5. Confirm no 404.
6. Connect TON wallet.
7. Buy Creator Pass with 0.2 TON.
8. Confirm memo is `KNR-CREATOR-PASS-{telegramId}`.
9. Confirm Creator Pass activates.
10. Confirm CR dashboard opens.
11. Confirm referrer receives pending CR if eligible.
12. Open Wallet.
13. Confirm GC and CR withdrawal are separate.
14. Try CR withdrawal below 1,000 CR and confirm blocked.
15. Try duplicate Creator Pass tx and confirm rejected.
16. Confirm Stars cannot activate Creator Pass.
17. Test VIP purchase.
18. Confirm VIP activates Creator Pass.
19. Confirm regular GC withdrawal still works.
20. Check backend logs for errors.

## Recommended rollout

Do not launch to everyone at once.

Suggested rollout:

```text
Day 1: 10-20 trusted testers
Day 2: 50-100 testers
Day 3: 500 users max
Day 4-7: first public creator push
```

Watch these metrics:

- API errors
- failed TON verifications
- duplicate tx attempts
- CR pending transactions
- withdrawal requests
- wallet connection failures
- fake/self-referral attempts
- support messages

## Hard launch blockers

Do not do a paid creator blast if any are true:

- `pnpm run typecheck` fails.
- `pnpm run build` fails.
- Backend health endpoint fails.
- Creator Pass TON payment does not verify.
- Wallet does not show CR.
- GC withdrawal breaks.
- Duplicate tx reuse is not rejected.
- BotFather still points to the old test URL.

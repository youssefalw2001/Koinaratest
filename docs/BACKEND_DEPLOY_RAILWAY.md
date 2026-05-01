# Koinara Backend Deploy on Railway

This repo now includes a production API Dockerfile and Railway config.

Files:

```text
Dockerfile.api
railway.json
```

## What you still need to do manually

You only need to add secrets and click deploy.

## Step 1 — Create Railway project

1. Open Railway.
2. New Project.
3. Deploy from GitHub repo.
4. Select `youssefalw2001/Koinaratest`.
5. Railway should detect `railway.json` and use `Dockerfile.api`.

## Step 2 — Add Postgres

1. In the same Railway project, add a Postgres database.
2. Copy its database connection string into the API service variable named `DATABASE_URL`.

## Step 3 — Add backend variables

Add these variables to the API service:

```text
NODE_ENV=production
PORT=3003
DATABASE_URL=your_postgres_connection_string
ADMIN_SECRET=make_a_long_random_password
CORS_ALLOWED_ORIGINS=https://youssefalw2001.github.io,https://youssefalw2001.github.io/Koinaratest
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
KOINARA_TON_WALLET=your_production_ton_wallet_address
LOG_LEVEL=info
```

Optional but recommended later:

```text
REDIS_URL=your_redis_url
VITE_API_URL=https://your-api-url.up.railway.app
```

## Step 4 — Deploy

Click Deploy.

The service builds with:

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
```

The service starts with:

```bash
pnpm --filter @workspace/api-server run start
```

## Step 5 — Test backend URL

After deploy, Railway gives you a public URL.

Test:

```text
https://YOUR_API_URL/api/healthz
https://YOUR_API_URL/api/readyz
https://YOUR_API_URL/api/market/price?symbol=BTCUSDT
```

Expected:

- `/api/healthz` returns `{ "status": "ok" }`.
- `/api/readyz` returns healthy service details.
- `/api/market/price?symbol=BTCUSDT` must return `source: "live"` before Trade can work.

## Step 6 — Deploy frontend

After backend works, use the GitHub Pages workflow:

```text
Actions → Deploy Koinara Frontend to GitHub Pages → Run workflow
```

Inputs:

```text
api_url=https://YOUR_API_URL
base_path=/Koinaratest/
```

## Step 7 — BotFather

Set your Mini App / Web App URL to:

```text
https://youssefalw2001.github.io/Koinaratest/
```

## Do not launch if

Do not launch public creators if any of these fail:

```text
/api/healthz
/api/readyz
/api/market/price?symbol=BTCUSDT
Trade screen says LIVE
Wallet shows verification
USDT TON withdrawal queues safely
```

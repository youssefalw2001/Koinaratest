# Koinara Operations & Go-Live Runbook

This repository contains the Koinara frontend, API server, and shared libraries.

## Services

- Frontend: `artifacts/alpha-predict-pro` (Vite app)
- API: `artifacts/api-server` (Express + Drizzle)
- Shared DB package: `lib/db`

## Required production environment variables

### API server

- `PORT`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_SECRET`
- `CORS_ALLOWED_ORIGINS` (comma-separated)

### Recommended API server variables

- `REDIS_URL` (for distributed rate limiting/idempotency durability)
- `LOG_LEVEL`
- `KOINARA_TON_WALLET`

### Frontend build variables

- `PORT`
- `BASE_PATH`
- `VITE_API_URL`

## Health endpoints

- Liveness: `GET /api/healthz`
- Readiness: `GET /api/readyz`
  - Verifies DB query path
  - Verifies Redis connectivity (if configured)
  - Returns `503` when DB is unavailable

## Deployment checklist (ordered)

1. **Backup DB** before any migration/push.
2. **Set environment variables** in deployment target.
3. **Apply schema updates**:
   - `pnpm --filter @workspace/db run push`
4. **Deploy API** and confirm:
   - `/api/healthz` -> `200`
   - `/api/readyz` -> `200` (or degraded if no Redis)
5. **Deploy frontend** with correct `VITE_API_URL`.
6. **Smoke test critical flows**:
   - register/login
   - place prediction
   - resolve prediction
   - crash bet + cashout
   - withdrawal request
7. **Verify logs/alerts** for 5xx and payout failures.

## Abuse/fraud guardrails currently implemented

- Route-aware API rate limiting (Redis-backed with memory fallback)
- Idempotency for payout-critical writes
- Telegram init-data based identity verification on protected routes
- Withdrawal velocity controls:
  - short cooldown window between requests
  - max requests per 24h per user

## Load testing

This repo includes a k6 smoke script:

```bash
pnpm --filter @workspace/scripts run loadtest:api-smoke
```

Set `API_BASE_URL` if needed:

```bash
API_BASE_URL="https://api.example.com" pnpm --filter @workspace/scripts run loadtest:api-smoke
```


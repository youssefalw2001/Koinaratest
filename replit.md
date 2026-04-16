# Workspace

## Overview

pnpm workspace monorepo using TypeScript. This is **Koinara** — a Telegram Mini App with a dual-currency economy.

## Product: Koinara

Dark cyber-fintech Telegram Mini App targeting MENA market.

### Dual-Currency Economy
- **🔵 Trade Credits (TC)** — engagement-only, non-withdrawable. Used to place predictions. Earned via quests, daily rewards.
- **🪙 Gold Coins (GC)** — real value, withdrawable via USDT TRC-20. Earned by winning trades at 0.85x payout ratio.

### Core Features
- 60-second BTC/USDT predictions (Long/Short), 0.85x GC payout
- VIP subscription ($4.99/wk or $14.99/mo via TON, or 500 TC/week)
- VIP perks: 2x GC multiplier, higher daily cap (3,000 GC), max bet 5,000 TC, withdrawal access
- Free daily GC cap: 800 GC
- Min bet: 50 TC | Max bet: 1,000 TC free / 5,000 TC VIP
- Daily login reward: 100-150+ TC (streak-based)
- Quest system: TC rewards for social/exchange tasks
- Referral program
- TON wallet connection for USDT withdrawal
- Leaderboard ranked by lifetime GC earned

### Design System
- Black background (#000)
- Cyan (#00f0ff) — Trade Credits, active states
- Gold (#f5c518) — Gold Coins, VIP
- Magenta (#ff2d78) — loss states, danger
- Font: Space Mono (monospace)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec) — but codegen scripts may not be available; hand-write Zod schemas in `lib/api-zod/src/generated/api.ts` and TS types in `lib/api-client-react/src/generated/api.schemas.ts`
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes

- **No `codegen` or `db:push` pnpm scripts** — Use direct SQL via `executeSql` for DB migrations; manually write Zod schemas and TS types
- **Binance WebSocket geo-blocked on Replit** (451 error) — Terminal has fallback price simulation
- **DB schema**: `lib/db/src/schema/users.ts` (dual-currency), plus `withdrawal_queue`, `ad_watches`, `gem_inventory` tables
- **Demo user**: telegramId "demo_user_123", username "koin_trader"
- Frontend at `artifacts/alpha-predict-pro` (Vite + React + Wouter + TanStack Query)
- API at `artifacts/api-server` (Express)
- API client: `lib/api-client-react` (React Query hooks)
- API Zod: `lib/api-zod` (server-side validation)

## DB Tables

- `users` — dual-currency user fields (tradeCredits, goldCoins, totalGcEarned, vipExpiresAt, dailyGcEarned, etc.)
- `predictions` — trade history (payout field = GC earned)
- `quests` + `quest_claims` — TC-reward quest system
- `withdrawal_queue` — GC withdrawal requests
- `ad_watches` — ad watch tracking
- `gem_inventory` — Gem Shop powerups

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

# 📋 MANUS CONTINUITY & HANDOVER PROMPT

**Context:**
I am working on the `youssefalw2001/Koinaratest` repository. A previous Manus instance has already completed the "Elite Terminal" and "Premium Brand" upgrades.

**Current State:**
1. **Brand Identity:** Redesigned header (Minimalist "KOINARA" with Gold Gradient, "Sovereign" removed).
2. **Elite Terminal:** Upgraded to professional **Candlestick Chart** with 5 MENA Power Pairs (BTC, ETH, SOL, GOLD, TON).
3. **Mines UI:** Controls moved **above** the grid; Arrow buttons for betting; VIP limit set to **8,000 TC**.
4. **Monetization Strategy:** GC-TC conversion **REMOVED** to protect brand revenue. TC Pack purchases (via TON) are the primary income.
5. **Security & Growth:** 5K bet button is **LOCKED** (Requires 5 referrals or VIP status).

**Your Mission (Pick up here):**
- **DO NOT** revert any UI, math, or brand changes mentioned above.
- **DO NOT** re-enable GC-TC conversion (it was removed to protect brand revenue).
- **STABILITY:** Always verify that `ReferenceLine` is imported in `Terminal.tsx` to prevent runtime crashes.
- **LIQUIDITY:** Maintain the 50% revenue payout cap in `withdrawals.ts` to protect the $2,000 starting budget.

**Safety Rules:**
- Keep the "Provably Fair" logic in Mines.
- Always perform a `pnpm build` locally before pushing to ensure no runtime crashes.
- If you need to change prices, ask for confirmation first.

---
**NEXT TASK FOR MANUS:**
[Insert what you want to do next, e.g., "Implement Referral Milestone Rewards" or "Add Live Win Ticker"]

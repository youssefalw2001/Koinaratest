# Koinara UI Redesign v1

This PR starts the frontend redesign direction without touching economy mechanics. The visual goal is to make Koinara feel premium, trustworthy, and easier to understand for users who care about earning progress, VIP referrals, and withdrawals.

## Design principles

1. **Trust first** — withdrawal rules, caps, conversion rates, and verification fee rules must be visible before users grind.
2. **Progress everywhere** — daily caps and withdrawal minimums should feel like goals, not hidden limits.
3. **Premium dark identity** — keep the existing crypto/terminal feeling, but make it cleaner with glass cards, gold/cyan accents, and less clutter.
4. **Indian-market growth loop** — VIP referral waiver and commission messaging should be obvious and motivating.
5. **No aggressive earning promises** — use responsible language like rewards, progress, verification, and limits.

## Page-by-page direction

### Home / Dashboard

The home page should become the main trust and progress screen.

Must show:

- GC and TC balances
- VIP status badge
- Withdrawal progress: `0 / 14,000 GC`
- Free conversion: `5,000 GC = $1`
- First verification: `$1.99 fee or waived with 1 VIP referral`
- Trade cap progress: `7,000 GC/day`
- Mines cap progress: `5,000 GC/day`
- Quick cards for Trade, Mines, Shop, Wallet, VIP, and Referrals
- Daily streak panel
- Small leaderboard preview

### Trade / Binary

The Trade page should stay fast and exciting, but the economy limits must be visible.

Must show:

- Live chart
- Up / Down actions
- Duration pills: 6s, 10s, 30s, 60s
- Bet buttons: 50, 100, 250, 500, 1,000, locked 5,000 TC
- Trade cap progress: `7,000 GC/day free`
- Per-trade payout guard messaging if needed
- Power-up tray using safer copy:
  - Hot Streak: `2x, 3 uses`
  - Starter Boost: `1.5x`
  - Big Swing: `2x high-risk boost`
  - Double Down: `2x next trade`

### Mines

The Mines page should feel more game-like and clearer about pass value.

Must show:

- Mines cap progress: `5,000 GC/day free`
- Tier selector: Bronze / Silver / Gold
- Bet selector
- Mine count selector
- Projected multiplier
- Power-up row: Safe Reveal, Gem Magnet, Revenge Shield, Second Chance
- Gold explanation: `TC bet × multiplier × conversion = GC payout`

### Shop / VIP

The Shop should become a premium monetization page.

Must show:

- VIP card: `$5.99 / month`
- VIP benefits: better conversion, higher caps, no first verification fee
- Referral CTA: `Invite 1 VIP to waive first withdrawal fee`
- Commission messaging: `20% direct VIP commission + 5% level 2` once backend supports it
- Power-up cards with updated safer effects
- TC pack cards

### Wallet / Withdraw

This is the most important trust page.

Must show:

- Available GC
- Free minimum: `14,000 GC`
- Free conversion: `5,000 GC = $1`
- Fee: `6%`
- Verification rule: `$1.99 or waived by 1 active VIP referral`
- VIP users skip the first verification fee
- Withdrawal status and history
- Clear warnings before the user submits

## Visual style

- Background: deep black/navy gradient
- Cards: glassmorphism with subtle gold/cyan borders
- Primary CTA: gold gradient
- Success/earnings: green/cyan
- Risk/warning: amber, not harsh red unless blocking
- Typography: keep Space Grotesk and JetBrains Mono
- Navigation: bottom nav with clear active states

## Implementation plan

1. PR #73 — design system foundation and redesign plan.
2. PR #74 — Wallet / withdrawal trust redesign.
3. PR #75 — Home dashboard redesign.
4. PR #76 — Shop / VIP / Referral redesign.
5. PR #77 — Trade and Mines visual polish.

This keeps each PR reviewable and reduces conflict risk.

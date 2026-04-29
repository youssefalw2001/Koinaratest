#!/usr/bin/env node

const SCENARIOS = [10000, 50000, 100000, 1000000];
const INR = 83;
const C = {
  vipRate: 0.018,
  verifyRate: 0.045,
  tcBuyerRate: 0.035,
  overtimeBuyerRate: 0.012,
  minesBuyerRate: 0.018,
  withdrawalAttemptRate: 0.05,
  eligibleWithdrawalRate: 0.32,
  paymentFailureRate: 0.035,
  farmRiskRate: 0.012,
  supportRate: 0.018,
  creatorRate: 0.13,
  vipUsd: 5.99,
  verifyUsd: 0.99,
  tcPackUsd: 2.99,
  overtimeUsd: 0.99,
  minesPassUsd: 0.32,
  avgFreeWithdrawalUsd: 3.4,
  avgVipWithdrawalUsd: 7.8,
  feePct: 0.06,
  referralCommissionPct: 0.17
};

const money = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const inr = (n) => `INR ${Math.round(n * INR).toLocaleString()}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const r = Math.round;

function simulate(users) {
  const vipUsers = r(users * C.vipRate);
  const verifiedUsers = r(users * C.verifyRate);
  const tcBuyers = r(users * C.tcBuyerRate);
  const overtimeBuyers = r(users * C.overtimeBuyerRate);
  const minesBuyers = r(users * C.minesBuyerRate);
  const paymentsStarted = vipUsers + verifiedUsers + tcBuyers + overtimeBuyers + minesBuyers;
  const paymentFailures = r(paymentsStarted * C.paymentFailureRate);
  const withdrawalAttempts = r(users * C.withdrawalAttemptRate);
  const eligibleWithdrawals = r(withdrawalAttempts * C.eligibleWithdrawalRate);
  const vipWithdrawals = r(eligibleWithdrawals * Math.min(0.45, C.vipRate * 12));
  const freeWithdrawals = eligibleWithdrawals - vipWithdrawals;
  const farmRiskUsers = r(users * C.farmRiskRate);
  const supportTickets = r(users * C.supportRate);
  const creatorDrivenUsers = r(users * C.creatorRate);

  const revenue =
    vipUsers * C.vipUsd +
    verifiedUsers * C.verifyUsd +
    tcBuyers * C.tcPackUsd +
    overtimeBuyers * C.overtimeUsd +
    minesBuyers * C.minesPassUsd;

  const grossPayout = freeWithdrawals * C.avgFreeWithdrawalUsd + vipWithdrawals * C.avgVipWithdrawalUsd;
  const fees = grossPayout * C.feePct;
  const netPayout = grossPayout - fees;
  const referralLiability = vipUsers * C.vipUsd * C.referralCommissionPct;
  const netBeforeInfra = revenue - netPayout - referralLiability;
  const coverage = revenue / Math.max(1, netPayout + referralLiability);

  const blockers = [];
  if (coverage < 1) blockers.push("Payout liability exceeds modeled revenue");
  if (paymentFailures > users * 0.05) blockers.push("Payment failures too high");
  if (farmRiskUsers > users * 0.02) blockers.push("Farm-risk users too high");
  if (supportTickets > users * 0.025) blockers.push("Support volume too high");

  const grade = Math.max(0, Math.min(100,
    72 +
    (coverage >= 1.5 ? 10 : coverage >= 1.0 ? 4 : -18) +
    (C.paymentFailureRate <= 0.03 ? 4 : -4) +
    (supportTickets / users < 0.02 ? 4 : -3) +
    (farmRiskUsers / users < 0.015 ? 4 : -5)
  ));

  return { users, vipUsers, verifiedUsers, tcBuyers, overtimeBuyers, minesBuyers, paymentFailures, withdrawalAttempts, eligibleWithdrawals, freeWithdrawals, vipWithdrawals, farmRiskUsers, supportTickets, creatorDrivenUsers, revenue, grossPayout, fees, netPayout, referralLiability, netBeforeInfra, coverage, blockers, grade };
}

function print(x) {
  console.log(`\n=== KOINARA SIMULATION: ${x.users.toLocaleString()} USERS ===`);
  console.log(`VIP users: ${x.vipUsers.toLocaleString()} (${pct(C.vipRate)})`);
  console.log(`Verified users: ${x.verifiedUsers.toLocaleString()} (${pct(C.verifyRate)})`);
  console.log(`TC buyers: ${x.tcBuyers.toLocaleString()}`);
  console.log(`Overtime buyers: ${x.overtimeBuyers.toLocaleString()}`);
  console.log(`Mines pass buyers: ${x.minesBuyers.toLocaleString()}`);
  console.log(`Creator-driven users: ${x.creatorDrivenUsers.toLocaleString()}`);
  console.log(`Payment failures/cancels: ${x.paymentFailures.toLocaleString()}`);
  console.log(`Withdrawal attempts: ${x.withdrawalAttempts.toLocaleString()}`);
  console.log(`Eligible withdrawals: ${x.eligibleWithdrawals.toLocaleString()} (${x.freeWithdrawals.toLocaleString()} free / ${x.vipWithdrawals.toLocaleString()} VIP)`);
  console.log(`Farm-risk users: ${x.farmRiskUsers.toLocaleString()}`);
  console.log(`Support tickets: ${x.supportTickets.toLocaleString()}`);
  console.log(`Gross revenue: ${money(x.revenue)} (${inr(x.revenue)})`);
  console.log(`Gross payout liability: ${money(x.grossPayout)} (${inr(x.grossPayout)})`);
  console.log(`Withdrawal fees retained: ${money(x.fees)} (${inr(x.fees)})`);
  console.log(`Net payout liability: ${money(x.netPayout)} (${inr(x.netPayout)})`);
  console.log(`Referral commission liability: ${money(x.referralLiability)} (${inr(x.referralLiability)})`);
  console.log(`Estimated net before infra: ${money(x.netBeforeInfra)} (${inr(x.netBeforeInfra)})`);
  console.log(`Payout coverage: ${x.coverage.toFixed(2)}x`);
  console.log(`Simulation grade: ${x.grade.toFixed(0)}/100`);
  console.log(x.blockers.length ? `BLOCKERS: ${x.blockers.join("; ")}` : "BLOCKERS: none in this model");
}

function printFlowMatrix() {
  console.log("\n=== CRITICAL FLOW MATRIX ===");
  [
    "Free user onboarding + starter balances",
    "VIP payment credits VIP only after verified TON tx",
    "Cancelled payment grants nothing",
    "TC pack credits once per tx hash",
    "Trade Overtime boosts cap once per UTC day",
    "Mines pass credits once per tx hash",
    "Safe Reveal only works after purchase and 3 safe tiles",
    "Bronze/Silver/Gold Mines currencies are correct",
    "Trade UP/DOWN uses selected pair, duration, bet, entry price, exit price",
    "Daily cap blocks farming and resets correctly",
    "Free withdrawal requires verification or waiver",
    "VIP withdrawal skips one-time verification",
    "Withdrawal request is idempotent and deducts once",
    "Duplicate tx hash cannot be reused",
    "Referral L1/L2 display matches ledger",
    "Hindi toggle does not expose incomplete Arabic",
    "Refresh on every route avoids 404",
    "Admin can mark withdrawal processing/complete/failed"
  ].forEach((v, i) => console.log(`${String(i + 1).padStart(2, "0")}. ${v}`));
}

console.log("Koinara launch simulation: deterministic model, not live traffic.");
console.log("Adjust assumptions in scripts/launch-simulation.mjs as real data arrives.");
const results = SCENARIOS.map(simulate);
results.forEach(print);
printFlowMatrix();
const million = results[results.length - 1];
console.log("\n=== RECOMMENDATION ===");
console.log(million.coverage < 1.25 ? "Do not hard launch to 1M without tighter payout caps and monitoring." : "Economy model can survive scale if payment verification and anti-farm controls work.");
console.log("Run: pnpm simulate:launch");

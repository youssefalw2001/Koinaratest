#!/usr/bin/env node

const baseUrl = (process.env.KOINARA_API_URL || process.env.VITE_API_URL || "").replace(/\/$/, "");
const concurrency = Number(process.env.KOINARA_CHECK_CONCURRENCY || 20);
const rounds = Number(process.env.KOINARA_CHECK_ROUNDS || 5);

if (!baseUrl) {
  console.error("Missing KOINARA_API_URL. Example: KOINARA_API_URL=https://your-app.up.railway.app node scripts/5k-readiness-check.mjs");
  process.exit(1);
}

const endpoints = [
  { name: "health", path: "/api/health", required: false },
  { name: "leaderboard", path: "/api/leaderboard", required: false },
  { name: "shop/prices", path: "/api/shop/prices", required: false },
];

function ms(start) {
  return Math.round(performance.now() - start);
}

async function hit(path) {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
    return { ok: res.ok, status: res.status, ms: ms(started) };
  } catch (err) {
    return { ok: false, status: 0, ms: ms(started), error: err?.message || String(err) };
  }
}

async function burst(endpoint) {
  const results = [];
  for (let r = 0; r < rounds; r++) {
    const batch = Array.from({ length: concurrency }, () => hit(endpoint.path));
    results.push(...await Promise.all(batch));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return results;
}

function summarize(name, results) {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const failed = total - ok;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)] || 0;
  const p90 = times[Math.floor(times.length * 0.9)] || 0;
  const p99 = times[Math.floor(times.length * 0.99)] || 0;
  const max = times[times.length - 1] || 0;
  console.log(`\n${name}`);
  console.log(`  requests: ${total}`);
  console.log(`  ok: ${ok}`);
  console.log(`  failed: ${failed}`);
  console.log(`  p50: ${p50}ms`);
  console.log(`  p90: ${p90}ms`);
  console.log(`  p99: ${p99}ms`);
  console.log(`  max: ${max}ms`);
  return { name, total, ok, failed, p50, p90, p99, max };
}

console.log("Koinara 5k readiness checker");
console.log(`Base URL: ${baseUrl}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Rounds: ${rounds}`);
console.log("This is a light endpoint check, not a full abuse load test.");

const summaries = [];
for (const endpoint of endpoints) {
  const single = await hit(endpoint.path);
  if (!single.ok && endpoint.required) {
    console.error(`Required endpoint failed: ${endpoint.name} ${endpoint.path} status=${single.status}`);
    process.exit(1);
  }
  if (!single.ok) {
    console.log(`\nSkipping optional endpoint ${endpoint.name} (${endpoint.path}) status=${single.status}`);
    continue;
  }
  const results = await burst(endpoint);
  summaries.push(summarize(endpoint.name, results));
}

console.log("\n5k readiness thresholds:");
console.log("  p90 under 1000ms: good");
console.log("  p90 1000-2500ms: acceptable for beta");
console.log("  p90 over 2500ms or any repeated 5xx: fix before scaling");

const risky = summaries.filter((s) => s.failed > 0 || s.p90 > 2500);
if (risky.length) {
  console.log("\nResult: NOT READY for 5k traffic yet.");
  risky.forEach((s) => console.log(`  - ${s.name}: failed=${s.failed}, p90=${s.p90}ms`));
  process.exitCode = 1;
} else {
  console.log("\nResult: basic endpoint readiness looks OK. Still test real payments and withdrawals manually.");
}

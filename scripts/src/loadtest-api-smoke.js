import http from "k6/http";
import { check, sleep } from "k6";

const API_BASE = __ENV.API_BASE_URL || __ENV.API_BASE || "http://localhost:3003";
const TELEGRAM_ID = __ENV.TELEGRAM_ID || "loadtest-user";
const INIT_DATA = __ENV.TELEGRAM_INIT_DATA || "";

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || "30s",
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<1200"],
  },
};

function authHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };
  if (INIT_DATA) {
    headers["X-Telegram-Init-Data"] = INIT_DATA;
  }
  return headers;
}

export default function () {
  const healthRes = http.get(`${API_BASE}/api/healthz`);
  check(healthRes, {
    "healthz is 200": (r) => r.status === 200,
  });

  const readyRes = http.get(`${API_BASE}/api/readyz`);
  check(readyRes, {
    "readyz is 200 or 503": (r) => r.status === 200 || r.status === 503,
  });

  const adStatusRes = http.get(
    `${API_BASE}/api/rewards/ad-status/${encodeURIComponent(TELEGRAM_ID)}`,
    { headers: authHeaders() },
  );
  check(adStatusRes, {
    "ad-status returns expected code": (r) => r.status === 200 || r.status === 404 || r.status === 401,
  });

  const withdrawBody = JSON.stringify({
    telegramId: TELEGRAM_ID,
    gcAmount: 10000,
    usdtWallet: "TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  const withdrawRes = http.post(`${API_BASE}/api/withdrawals/request`, withdrawBody, {
    headers: {
      ...authHeaders(),
      "Idempotency-Key": `k6-${__VU}-${__ITER}`,
    },
  });
  check(withdrawRes, {
    "withdraw endpoint guarded": (r) =>
      [200, 400, 401, 403, 404, 409, 429, 503].includes(r.status),
  });

  sleep(1);
}

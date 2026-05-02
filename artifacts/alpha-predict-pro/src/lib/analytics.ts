const PRODUCTION_API_URL = "https://workspaceapi-server-production-4e16.up.railway.app";
const API_ROOT = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || PRODUCTION_API_URL);
const API_BASE = `${API_ROOT}/api`;

export type AnalyticsMetadata = Record<string, string | number | boolean | null | undefined>;

function initHeaders(): Record<string, string> {
  const initData = window.Telegram?.WebApp?.initData ?? "";
  return initData ? { "x-telegram-init-data": initData } : {};
}

function getSessionId(): string {
  const key = "koinara_session_id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(key, next);
  return next;
}

export function getLaunchSource(): string | null {
  const tgSource = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if (tgSource) return tgSource;
  const params = new URLSearchParams(window.location.search);
  return params.get("source") || params.get("ref") || params.get("utm_source") || null;
}

export function trackEvent(eventType: string, options: { telegramId?: string | null; route?: string | null; metadata?: AnalyticsMetadata } = {}): void {
  try {
    const body = JSON.stringify({
      telegramId: options.telegramId ?? null,
      eventType,
      source: getLaunchSource(),
      sessionId: getSessionId(),
      route: options.route ?? window.location.pathname,
      metadata: options.metadata ?? {},
    });

    void fetch(`${API_BASE}/analytics/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...initHeaders() },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Analytics must never break gameplay.
  }
}

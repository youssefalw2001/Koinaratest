from __future__ import annotations

import concurrent.futures
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

BASE = "https://gmgn.ai"
ROUTES = (
    "/",
    "/rewards",
    "/settings",
    "/profile",
    "/wallet",
    "/portfolio",
    "/watchlist",
    "/trenches",
    "/discover",
    "/trade",
    "/login",
    "/tglogin",
    "/referral",
    "/invite",
    "/sol",
    "/bsc",
    "/base",
    "/eth",
)
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MAX_SCRIPTS = 300
MAX_SCRIPT_BYTES = 18_000_000
WORKERS = 16

SINKS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "react_dangerouslySetInnerHTML",
        re.compile(
            r"dangerouslySetInnerHTML\s*:\s*\{\s*__html\s*:\s*(?P<expr>[^}\n]{1,1000})",
            re.I,
        ),
    ),
    (
        "innerHTML_assignment",
        re.compile(r"\.innerHTML\s*=\s*(?P<expr>[^;\n]{1,1000})", re.I),
    ),
    (
        "outerHTML_assignment",
        re.compile(r"\.outerHTML\s*=\s*(?P<expr>[^;\n]{1,1000})", re.I),
    ),
    (
        "insertAdjacentHTML",
        re.compile(
            r"insertAdjacentHTML\s*\(\s*[^,]{1,120},\s*(?P<expr>[^)\n]{1,1000})",
            re.I,
        ),
    ),
    (
        "document_write",
        re.compile(r"document\.write(?:ln)?\s*\(\s*(?P<expr>[^)\n]{1,1000})", re.I),
    ),
    (
        "react_srcDoc",
        re.compile(r"srcDoc\s*:\s*(?P<expr>[^,}\n]{1,1000})", re.I),
    ),
    (
        "createContextualFragment",
        re.compile(r"createContextualFragment\s*\(\s*(?P<expr>[^)\n]{1,1000})", re.I),
    ),
    (
        "domparser_html",
        re.compile(
            r"parseFromString\s*\(\s*(?P<expr>[^,\n]{1,1000}),\s*[\"']text/html[\"']",
            re.I,
        ),
    ),
    (
        "eval",
        re.compile(r"(?<![A-Za-z0-9_$])eval\s*\(\s*(?P<expr>[^)\n]{1,1000})", re.I),
    ),
    (
        "new_Function",
        re.compile(r"new\s+Function\s*\(\s*(?P<expr>[^)\n]{1,1000})", re.I),
    ),
)

SOURCE_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "url": (
        re.compile(r"(?:window\.)?location\.(?:search|hash|href|pathname)", re.I),
        re.compile(r"document\.(?:URL|documentURI|referrer)", re.I),
        re.compile(r"URLSearchParams", re.I),
        re.compile(r"\.searchParams\b", re.I),
        re.compile(r"\.query(?:\.|\[)", re.I),
        re.compile(r"\.asPath\b", re.I),
    ),
    "postmessage": (
        re.compile(r"addEventListener\s*\(\s*[\"']message[\"']", re.I),
        re.compile(r"\bonmessage\s*=", re.I),
        re.compile(r"\b(?:event|evt|messageEvent|e)\.data\b", re.I),
    ),
    "storage": (
        re.compile(r"\b(?:localStorage|sessionStorage)\b", re.I),
        re.compile(r"document\.cookie", re.I),
    ),
    "input": (
        re.compile(r"\.target\.value\b", re.I),
        re.compile(r"\.currentTarget\.value\b", re.I),
        re.compile(r"contentEditable", re.I),
    ),
    "api_content": (
        re.compile(r"\b(?:response|resp|result|payload)\.(?:data|body)\b", re.I),
        re.compile(r"\.(?:html|content|description|markdown|message|bio|title|name)\b", re.I),
        re.compile(r"\b(?:invite_code|invited_code|referral_code|invite_info)\b", re.I),
    ),
}

SANITIZERS = (
    re.compile(r"DOMPurify", re.I),
    re.compile(r"sanitize(?:Html|HTML)?\s*\(", re.I),
    re.compile(r"escape(?:Html|HTML)?\s*\(", re.I),
    re.compile(r"htmlEscape", re.I),
)

IDENTIFIER_RE = re.compile(r"\b[A-Za-z_$][A-Za-z0-9_$]*\b")
ASSIGNMENT_RE = re.compile(
    r"(?:(?:var|let|const)\s+)?(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?P<rhs>[^;\n]{1,700})"
)
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)


def fetch(url: str, max_bytes: int = MAX_SCRIPT_BYTES) -> tuple[int | None, dict[str, str], bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/javascript,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                body = body[:max_bytes]
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, body, None
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read(200_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, {}, b"", f"{type(exc).__name__}: {exc}"


def fetch_many(urls: Iterable[str]) -> dict[str, tuple[int | None, dict[str, str], bytes, str | None]]:
    url_list = list(dict.fromkeys(urls))
    out: dict[str, tuple[int | None, dict[str, str], bytes, str | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url): url for url in url_list}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                out[url] = future.result()
            except Exception as exc:  # noqa: BLE001
                out[url] = (None, {}, b"", f"{type(exc).__name__}: {exc}")
    return out


def normalize_js_url(raw: str, base_url: str) -> str | None:
    raw = html.unescape(raw).replace("\\/", "/")
    url = urllib.parse.urljoin(base_url, raw)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not (parsed.hostname == "gmgn.ai" or (parsed.hostname or "").endswith(".gmgn.ai")):
        return None
    if not (parsed.path.endswith(".js") or ".js?" in url):
        return None
    return url


def discover_js(text: str, base_url: str) -> set[str]:
    found: set[str] = set()
    patterns = (
        r"<script[^>]+src=[\"']([^\"']+)[\"']",
        r"[\"'](https?://[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"'](/_next/static/[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"']([^\"']+\.js(?:\?[^\"']*)?)[\"']",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            url = normalize_js_url(match.group(1), base_url)
            if url:
                found.add(url)
    return found


def find_matching_brace(text: str, open_index: int) -> int | None:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    index = open_index
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""

        if line_comment:
            if char in "\r\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if char == "*" and nxt == "/":
                block_comment = False
                index += 2
                continue
            index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue

        if char == "/" and nxt == "/":
            line_comment = True
            index += 2
            continue
        if char == "/" and nxt == "*":
            block_comment = True
            index += 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def webpack_modules(text: str) -> list[tuple[str, int, int, str]]:
    modules: list[tuple[str, int, int, str]] = []
    seen_starts: set[int] = set()
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        if open_index in seen_starts:
            continue
        seen_starts.add(open_index)
        close_index = find_matching_brace(text, open_index)
        if close_index is None:
            continue
        modules.append((match.group("id"), match.start(), close_index + 1, text[open_index + 1 : close_index]))
    return modules


def source_groups(text: str) -> list[str]:
    return [group for group, patterns in SOURCE_PATTERNS.items() if any(p.search(text) for p in patterns)]


def sanitizer_hits(text: str) -> list[str]:
    return [pattern.pattern for pattern in SANITIZERS if pattern.search(text)]


def identifiers(text: str) -> set[str]:
    return set(IDENTIFIER_RE.findall(text))


def assignment_graph(module: str) -> dict[str, dict[str, Any]]:
    graph: dict[str, dict[str, Any]] = {}
    for match in ASSIGNMENT_RE.finditer(module):
        name = match.group("name")
        rhs = match.group("rhs")[:700]
        graph[name] = {
            "rhs": rhs,
            "sources": set(source_groups(rhs)),
            "deps": identifiers(rhs),
        }

    for _ in range(6):
        changed = False
        for name, node in graph.items():
            before = set(node["sources"])
            for dep in node["deps"]:
                if dep in graph:
                    node["sources"].update(graph[dep]["sources"])
            if node["sources"] != before:
                changed = True
        if not changed:
            break
    return graph


def parameter_names(module_prefix: str) -> set[str]:
    match = re.search(r":(?:function\((?P<fn>[^)]*)\)|\((?P<arrow>[^)]*)\)=>|(?P<single>[A-Za-z_$][A-Za-z0-9_$]*)=>)\{$", module_prefix)
    raw = ""
    if match:
        raw = match.group("fn") or match.group("arrow") or match.group("single") or ""
    return {part.strip() for part in raw.split(",") if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$]*", part.strip())}


def extract_query_keys(text: str) -> list[str]:
    keys: set[str] = set()
    patterns = (
        re.compile(r"(?:searchParams|URLSearchParams[^;]{0,250})\.get\(\s*[\"']([^\"']+)[\"']", re.I),
        re.compile(r"\.query\.([A-Za-z0-9_]{1,80})"),
        re.compile(r"\.query\[\s*[\"']([^\"']+)[\"']\s*\]"),
        re.compile(r"\.get\(\s*[\"']([^\"']+)[\"']\s*\)"),
    )
    for pattern in patterns:
        for match in pattern.finditer(text):
            key = match.group(1)
            if 1 <= len(key) <= 80:
                keys.add(key)
    return sorted(keys)


def route_hint(script_url: str, module: str) -> str | None:
    parsed = urllib.parse.urlparse(script_url)
    match = re.search(r"/chunks/pages/([^?]+?)-[A-Fa-f0-9]{8,}\.js$", parsed.path)
    if match:
        route = match.group(1)
        if route == "index":
            return "/"
        return "/" + route.replace("%5B", "[").replace("%5D", "]")
    sentry = re.search(r'data-sentry-source-file:[\"']([^\"']+)[\"']', module)
    if sentry:
        return sentry.group(1)
    return None


def context(text: str, start: int, end: int, radius: int = 1400) -> str:
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    return re.sub(r"\s+", " ", text[lo:hi])[:7000]


def scan_module(script_url: str, module_id: str, module_start: int, module_end: int, module: str, prefix: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    graph = assignment_graph(module)
    module_sources = source_groups(module)
    params = parameter_names(prefix)
    query_keys = extract_query_keys(module)
    hint = route_hint(script_url, module)
    vendor = any(part in script_url for part in ("vendors", "framework", "polyfills", "webpack"))

    for sink_name, pattern in SINKS:
        for match in pattern.finditer(module):
            expr = (match.groupdict().get("expr") or "").strip()[:1500]
            expr_sources = set(source_groups(expr))
            expr_ids = identifiers(expr)
            alias_sources: dict[str, list[str]] = {}
            for ident in expr_ids:
                if ident in graph and graph[ident]["sources"]:
                    groups = sorted(graph[ident]["sources"])
                    expr_sources.update(groups)
                    alias_sources[ident] = groups

            param_flow = sorted(expr_ids & params)
            local_context = context(module, match.start(), match.end())
            sanitizers = sanitizer_hits(local_context)

            score = 12
            reasons = [f"sink={sink_name}"]
            weights = {"url": 65, "postmessage": 60, "storage": 42, "input": 38, "api_content": 24}
            module_weights = {"url": 22, "postmessage": 20, "storage": 12, "input": 12, "api_content": 8}
            for group in sorted(expr_sources):
                score += weights[group]
                reasons.append(f"tainted sink expression via {group}")
            for group in module_sources:
                if group not in expr_sources:
                    score += module_weights[group]
                    reasons.append(f"same module contains {group} source")
            if param_flow:
                score += 18
                reasons.append(f"sink expression uses module/function parameter(s): {', '.join(param_flow)}")
            if sanitizers:
                score -= 35
                reasons.append("sanitizer found in local context")
            else:
                score += 10
                reasons.append("no sanitizer found in local context")
            if vendor:
                score -= 18
                reasons.append("vendor/framework chunk")
            else:
                score += 10
                reasons.append("application chunk")
            if sink_name in {"eval", "new_Function"}:
                score += 10
            if sink_name in {"react_dangerouslySetInnerHTML", "innerHTML_assignment", "outerHTML_assignment"}:
                score += 8
            if any(term in module for term in ("invite_code", "invited_code", "referral_code")):
                score += 8
                reasons.append("referral data present in module")

            results.append(
                {
                    "score": score,
                    "script_url": script_url,
                    "module_id": module_id,
                    "module_start": module_start,
                    "module_end": module_end,
                    "route_hint": hint,
                    "sink": sink_name,
                    "expression": expr,
                    "expression_sources": sorted(expr_sources),
                    "alias_sources": alias_sources,
                    "module_sources": module_sources,
                    "parameter_flow": param_flow,
                    "query_keys": query_keys,
                    "sanitizers_in_context": sanitizers,
                    "reasons": reasons,
                    "context": local_context,
                }
            )
    return results


def main() -> int:
    route_urls = [urllib.parse.urljoin(BASE, route) for route in ROUTES]
    route_results = fetch_many(route_urls)
    discovered: set[str] = set()
    route_summary: list[dict[str, Any]] = []

    for url, (status, headers, body, error) in route_results.items():
        text = body.decode("utf-8", errors="replace")
        scripts = discover_js(text, url)
        discovered.update(scripts)
        route_summary.append(
            {
                "url": url,
                "status": status,
                "error": error,
                "bytes": len(body),
                "content_type": headers.get("content-type"),
                "scripts": len(scripts),
            }
        )

    script_bodies: dict[str, str] = {}
    pending = set(discovered)
    while pending and len(script_bodies) < MAX_SCRIPTS:
        batch = sorted(pending)[: min(40, MAX_SCRIPTS - len(script_bodies))]
        pending.difference_update(batch)
        for url, (status, _headers, body, _error) in fetch_many(batch).items():
            if status != 200 or not body:
                continue
            text = body.decode("utf-8", errors="replace")
            script_bodies[url] = text
            for child in discover_js(text, url):
                if child not in script_bodies and len(script_bodies) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    candidates: list[dict[str, Any]] = []
    script_summary: list[dict[str, Any]] = []
    module_count = 0

    for script_url, text in script_bodies.items():
        modules = webpack_modules(text)
        module_count += len(modules)
        sink_count = 0
        for module_id, start, end, module in modules:
            prefix = text[max(0, start - 120) : text.find("{", start) + 1]
            found = scan_module(script_url, module_id, start, end, module, prefix)
            candidates.extend(found)
            sink_count += len(found)
        script_summary.append(
            {
                "script_url": script_url,
                "bytes": len(text),
                "modules": len(modules),
                "sink_candidates": sink_count,
            }
        )

    candidates.sort(key=lambda item: (-item["score"], item["script_url"], item["module_id"], item["sink"]))
    direct = [candidate for candidate in candidates if candidate["expression_sources"]]
    url_direct = [candidate for candidate in direct if "url" in candidate["expression_sources"]]
    postmessage_direct = [candidate for candidate in direct if "postmessage" in candidate["expression_sources"]]
    browser_probe_candidates = [
        candidate
        for candidate in candidates
        if candidate["route_hint"]
        and candidate["query_keys"]
        and ("url" in candidate["expression_sources"] or "url" in candidate["module_sources"])
        and candidate["score"] >= 55
    ]

    report = {
        "generated_at": int(time.time()),
        "scope": "unauthenticated public HTML and JavaScript static analysis only",
        "routes": sorted(route_summary, key=lambda item: item["url"]),
        "summary": {
            "scripts_fetched": len(script_bodies),
            "webpack_modules_scanned": module_count,
            "all_sink_candidates": len(candidates),
            "direct_tainted_sink_candidates": len(direct),
            "direct_url_to_sink_candidates": len(url_direct),
            "direct_postmessage_to_sink_candidates": len(postmessage_direct),
            "browser_probe_candidates": len(browser_probe_candidates),
            "limitations": [
                "Regex and alias propagation are conservative approximations, not a full JavaScript parser.",
                "A browser marker must execute before a DOM XSS is confirmed.",
                "No credentials, cookies, POST requests, state changes or injected persistent data were used.",
            ],
        },
        "browser_probe_candidates": browser_probe_candidates[:100],
        "direct_url_to_sink_candidates": url_direct[:150],
        "direct_postmessage_to_sink_candidates": postmessage_direct[:150],
        "direct_tainted_sink_candidates": direct[:250],
        "top_candidates": candidates[:350],
        "scripts": sorted(script_summary, key=lambda item: item["script_url"]),
    }

    out = Path("gmgn_minified_xss_report.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for candidate in candidates[:60]:
        print(
            "CANDIDATE",
            json.dumps(
                {
                    "score": candidate["score"],
                    "script_url": candidate["script_url"],
                    "module_id": candidate["module_id"],
                    "route_hint": candidate["route_hint"],
                    "sink": candidate["sink"],
                    "expression": candidate["expression"][:500],
                    "expression_sources": candidate["expression_sources"],
                    "alias_sources": candidate["alias_sources"],
                    "module_sources": candidate["module_sources"],
                    "parameter_flow": candidate["parameter_flow"],
                    "query_keys": candidate["query_keys"],
                    "sanitizers": candidate["sanitizers_in_context"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

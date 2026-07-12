from __future__ import annotations

import concurrent.futures
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

BASE = "https://gmgn.ai"
ROUTES = (
    "/",
    "/login",
    "/tglogin",
    "/rewards",
    "/invite",
    "/referral",
    "/settings",
    "/profile",
    "/trade",
    "/portfolio",
    "/discover",
    "/trenches",
    "/watchlist",
    "/sol",
    "/bsc",
    "/base",
    "/eth",
)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 380
MAX_BYTES = 24_000_000
WORKERS = 16
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)
IDENTIFIER_RE = re.compile(r"\b[A-Za-z_$][A-Za-z0-9_$]*\b")

SOURCE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("location_search", re.compile(r"(?:window\.)?location\.(?:search|hash|href)", re.I)),
    ("url_search_params", re.compile(r"URLSearchParams|searchParams\.(?:get|getAll)\s*\(", re.I)),
    ("router_query", re.compile(r"\.query(?:\.|\[)|\.asPath\b|\.pathname\b", re.I)),
    ("next_search_params", re.compile(r"useSearchParams\s*\(", re.I)),
)

SINK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("router_push", re.compile(r"\.push\s*\(\s*(?P<expr>[^,\)\n]{1,1400})", re.I)),
    ("router_replace", re.compile(r"\.replace\s*\(\s*(?P<expr>[^,\)\n]{1,1400})", re.I)),
    ("location_assign", re.compile(r"location\.assign\s*\(\s*(?P<expr>[^\)\n]{1,1400})", re.I)),
    ("location_replace", re.compile(r"location\.replace\s*\(\s*(?P<expr>[^\)\n]{1,1400})", re.I)),
    ("location_href", re.compile(r"location\.href\s*=\s*(?P<expr>[^;\n]{1,1400})", re.I)),
    ("window_open", re.compile(r"window\.open\s*\(\s*(?P<expr>[^,\)\n]{1,1400})", re.I)),
)

QUERY_KEY_RE = re.compile(
    r"(?:\.get\s*\(\s*[\"'](?P<get>[^\"']+)[\"']|\.query\.([A-Za-z0-9_-]+)|\.query\[\s*[\"']([^\"']+)[\"']\s*\])",
    re.I,
)
REDIRECT_KEYS = {
    "redirect",
    "redirect_url",
    "redirectUrl",
    "returnUrl",
    "return_url",
    "callback",
    "callbackUrl",
    "callback_url",
    "next",
    "continue",
    "from",
    "url",
    "target",
    "to",
    "goto",
    "dest",
    "destination",
}
VALIDATOR_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("safe_url", re.compile(r"isSafeUrl|safeUrl|sanitizeUrl|validateUrl|getTargetUrl", re.I)),
    ("http_prefix", re.compile(r"startsWith\s*\(\s*[\"']https?|^https?", re.I)),
    ("url_parser", re.compile(r"new\s+URL\s*\(|URL\.canParse", re.I)),
    ("scheme_block", re.compile(r"javascript:|data:|vbscript:|file:|blob:", re.I)),
    ("same_origin", re.compile(r"location\.origin|\.origin\s*(?:===|==)|(?:===|==)\s*[^;]{0,100}\.origin", re.I)),
    ("relative_only", re.compile(r"startsWith\s*\(\s*[\"']/[\"']|^/[A-Za-z]", re.I)),
)

ASSIGN_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"(?:(?:let|const|var)\s+)?(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?P<rhs>[^,;\n]{1,900})"
    ),
    re.compile(
        r"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?P<rhs>[^?]{0,400}(?:\.query|searchParams|URLSearchParams|location\.(?:search|hash|href))[^,;\n]{0,600})",
        re.I,
    ),
)


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(MAX_BYTES), None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(250_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def fetch_many(urls: Iterable[str]) -> dict[str, tuple[int | None, bytes, str | None]]:
    unique = list(dict.fromkeys(urls))
    output: dict[str, tuple[int | None, bytes, str | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url): url for url in unique}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                output[url] = future.result()
            except Exception as exc:  # noqa: BLE001
                output[url] = (None, b"", f"{type(exc).__name__}: {exc}")
    return output


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


def matching_brace(text: str, open_index: int) -> int | None:
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


def modules(text: str) -> list[tuple[str, int, int, str]]:
    output: list[tuple[str, int, int, str]] = []
    seen: set[int] = set()
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        if open_index in seen:
            continue
        seen.add(open_index)
        close_index = matching_brace(text, open_index)
        if close_index is None:
            continue
        output.append((match.group("id"), match.start(), close_index + 1, text[open_index + 1 : close_index]))
    return output


def source_hits(text: str) -> list[str]:
    return [name for name, pattern in SOURCE_PATTERNS if pattern.search(text)]


def validator_hits(text: str) -> list[str]:
    return [name for name, pattern in VALIDATOR_PATTERNS if pattern.search(text)]


def query_keys(text: str) -> list[str]:
    output: set[str] = set()
    for match in QUERY_KEY_RE.finditer(text):
        value = next((group for group in match.groups() if group), None)
        if value:
            output.add(value)
    for key in REDIRECT_KEYS:
        if re.search(rf"[\"']{re.escape(key)}[\"']", text):
            output.add(key)
    return sorted(output)


def identifiers(text: str) -> set[str]:
    return set(IDENTIFIER_RE.findall(text))


def assignment_graph(text: str) -> dict[str, dict[str, Any]]:
    graph: dict[str, dict[str, Any]] = {}
    for pattern in ASSIGN_PATTERNS:
        for match in pattern.finditer(text):
            name = match.group("name")
            rhs = match.group("rhs")[:900]
            graph[name] = {
                "rhs": rhs,
                "sources": set(source_hits(rhs)),
                "keys": set(query_keys(rhs)),
                "deps": identifiers(rhs),
            }
    for _ in range(8):
        changed = False
        for node in graph.values():
            before_sources = set(node["sources"])
            before_keys = set(node["keys"])
            for dep in node["deps"]:
                if dep in graph:
                    node["sources"].update(graph[dep]["sources"])
                    node["keys"].update(graph[dep]["keys"])
            if node["sources"] != before_sources or node["keys"] != before_keys:
                changed = True
        if not changed:
            break
    return graph


def sentry_files(text: str) -> list[str]:
    found = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    found.update(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    return sorted(found)


def main() -> int:
    discovered: set[str] = set()
    route_results = fetch_many([urllib.parse.urljoin(BASE, route) for route in ROUTES])
    for url, (status, body, _error) in route_results.items():
        if status == 200:
            discovered.update(discover_js(body.decode("utf-8", errors="replace"), url))

    scripts: dict[str, str] = {}
    pending = set(discovered)
    while pending and len(scripts) < MAX_SCRIPTS:
        batch = sorted(pending)[: min(40, MAX_SCRIPTS - len(scripts))]
        pending.difference_update(batch)
        for url, (status, body, _error) in fetch_many(batch).items():
            if status != 200 or not body:
                continue
            text = body.decode("utf-8", errors="replace")
            scripts[url] = text
            for child in discover_js(text, url):
                if child not in scripts and len(scripts) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    records: list[dict[str, Any]] = []
    module_count = 0
    for script_url, text in scripts.items():
        vendor = any(marker in script_url for marker in ("core-vendors", "blockchain-vendors", "framework", "webpack", "polyfills"))
        for module_id, start, end, body in modules(text):
            module_count += 1
            if not any(pattern.search(body) for _, pattern in SOURCE_PATTERNS):
                continue
            if not any(pattern.search(body) for _, pattern in SINK_PATTERNS):
                continue
            graph = assignment_graph(body)
            module_sources = source_hits(body)
            module_keys = query_keys(body)
            source_files = sentry_files(body)
            for sink_name, sink_pattern in SINK_PATTERNS:
                for match in sink_pattern.finditer(body):
                    expr = (match.groupdict().get("expr") or "").strip()[:1600]
                    expr_sources = set(source_hits(expr))
                    expr_keys = set(query_keys(expr))
                    aliases: dict[str, Any] = {}
                    for identifier in identifiers(expr):
                        if identifier in graph and (graph[identifier]["sources"] or graph[identifier]["keys"]):
                            aliases[identifier] = {
                                "rhs": graph[identifier]["rhs"],
                                "sources": sorted(graph[identifier]["sources"]),
                                "keys": sorted(graph[identifier]["keys"]),
                            }
                            expr_sources.update(graph[identifier]["sources"])
                            expr_keys.update(graph[identifier]["keys"])
                    lo = max(0, match.start() - 3500)
                    hi = min(len(body), match.end() + 4500)
                    context = re.sub(r"\s+", " ", body[lo:hi])
                    validators = validator_hits(context)
                    score = 0
                    reasons: list[str] = []
                    if expr_sources:
                        score += 50
                        reasons.append("query/URL source reaches sink expression")
                    elif module_sources:
                        score += 15
                        reasons.append("query/URL source exists in same module")
                    if expr_keys & REDIRECT_KEYS:
                        score += 35
                        reasons.append("redirect-like query key reaches sink expression")
                    elif set(module_keys) & REDIRECT_KEYS:
                        score += 12
                        reasons.append("redirect-like key exists in same module")
                    if aliases:
                        score += 15
                    if validators:
                        score -= 35
                        reasons.append("URL validator present near sink")
                    else:
                        score += 12
                        reasons.append("no URL validator near sink")
                    if source_files:
                        score += 10
                    if vendor:
                        score -= 30
                    if sink_name in {"location_assign", "location_replace", "location_href", "window_open"}:
                        score += 12
                    records.append(
                        {
                            "score": score,
                            "script_url": script_url,
                            "module_id": module_id,
                            "module_start": start,
                            "module_end": end,
                            "source_files": source_files,
                            "vendor": vendor,
                            "sink": sink_name,
                            "expression": expr,
                            "expression_sources": sorted(expr_sources),
                            "expression_query_keys": sorted(expr_keys),
                            "aliases": aliases,
                            "module_sources": module_sources,
                            "module_query_keys": module_keys,
                            "validators_in_context": validators,
                            "reasons": reasons,
                            "context": context,
                            "body": body if len(body) <= 240_000 else None,
                        }
                    )

    records.sort(key=lambda item: (-item["score"], item["script_url"], item["module_id"], item["sink"]))
    direct = [
        record
        for record in records
        if record["expression_sources"]
        and not record["validators_in_context"]
        and not record["vendor"]
    ]
    redirect_direct = [
        record
        for record in direct
        if set(record["expression_query_keys"]) & REDIRECT_KEYS
    ]
    report = {
        "scope": "unauthenticated static analysis of public redirect/query navigation flows",
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_scanned": module_count,
            "cooccurrence_candidates": len(records),
            "direct_unvalidated_candidates": len(direct),
            "direct_redirect_key_candidates": len(redirect_direct),
        },
        "direct_redirect_key_candidates": redirect_direct,
        "direct_unvalidated_candidates": direct,
        "top_candidates": records[:400],
    }
    out = Path("gmgn_redirect_dataflow_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for record in direct[:100]:
        print(
            "DIRECT",
            json.dumps(
                {
                    "score": record["score"],
                    "script_url": record["script_url"],
                    "module_id": record["module_id"],
                    "source_files": record["source_files"],
                    "sink": record["sink"],
                    "expression": record["expression"][:700],
                    "expression_sources": record["expression_sources"],
                    "expression_query_keys": record["expression_query_keys"],
                    "aliases": record["aliases"],
                    "validators": record["validators_in_context"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

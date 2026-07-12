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
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 360
MAX_BYTES = 22_000_000
WORKERS = 16
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)
IDENTIFIER_RE = re.compile(r"\b[A-Za-z_$][A-Za-z0-9_$]*\b")
ASSIGNMENT_RE = re.compile(
    r"(?:(?:var|let|const)\s+)?(?P<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?P<rhs>[^;\n]{1,900})"
)
SINKS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("window_open", re.compile(r"(?:window\.)?open\s*\(\s*(?P<expr>[^,\)\n]{1,1000})", re.I)),
    ("location_assign", re.compile(r"(?:window\.)?location\.assign\s*\(\s*(?P<expr>[^\)\n]{1,1000})", re.I)),
    ("location_replace", re.compile(r"(?:window\.)?location\.replace\s*\(\s*(?P<expr>[^\)\n]{1,1000})", re.I)),
    ("location_href", re.compile(r"(?:window\.|document\.)?location\.href\s*=\s*(?P<expr>[^;\n]{1,1000})", re.I)),
    ("location_direct", re.compile(r"(?:window\.|document\.)location\s*=\s*(?P<expr>[^;\n]{1,1000})", re.I)),
    ("iframe_src", re.compile(r"(?:iframe|Iframe)[^\n]{0,600}?src\s*:\s*(?P<expr>[^,}\n]{1,1000})", re.I)),
    ("react_href", re.compile(r"href\s*:\s*(?P<expr>[^,}\n]{1,1000})", re.I)),
)

SOURCE_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "social_metadata": (
        re.compile(r"\.(?:website|website_url|websiteUrl|homepage|external_url|externalUrl)\b", re.I),
        re.compile(r"\.(?:twitter|twitter_url|twitterUrl|telegram|telegram_url|telegramUrl|discord|discord_url|discordUrl)\b", re.I),
        re.compile(r"\.(?:social|socials|links|link|url|uri)\b", re.I),
        re.compile(r"\b(?:website|homepage|twitter|telegram|discord|socials?)\b", re.I),
    ),
    "token_metadata": (
        re.compile(r"\.(?:symbol|name|description|logo|image|icon)\b", re.I),
        re.compile(r"\btoken(?:Info|Detail|Metadata)?\b", re.I),
    ),
    "url_input": (
        re.compile(r"(?:window\.)?location\.(?:search|hash|href|pathname)", re.I),
        re.compile(r"URLSearchParams", re.I),
        re.compile(r"\.query(?:\.|\[)", re.I),
        re.compile(r"\.target\.value\b", re.I),
    ),
    "api_response": (
        re.compile(r"\b(?:response|resp|result|payload|data)\.(?:data|body|result)?\b", re.I),
        re.compile(r"\bqueryFn\b|\buseQuery\b|\.then\s*\(", re.I),
    ),
}

VALIDATOR_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^https?", re.I),
    re.compile(r"startsWith\s*\(\s*[\"']https?", re.I),
    re.compile(r"/^\\?https?", re.I),
    re.compile(r"new\s+URL\s*\(", re.I),
    re.compile(r"URL\.canParse", re.I),
    re.compile(r"isValidUrl|isSafeUrl|safeUrl|sanitizeUrl|normalizeUrl|validateUrl", re.I),
    re.compile(r"javascript:", re.I),
    re.compile(r"encodeURI(?:Component)?\s*\(", re.I),
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
    out: dict[str, tuple[int | None, bytes, str | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url): url for url in unique}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                out[url] = future.result()
            except Exception as exc:  # noqa: BLE001
                out[url] = (None, b"", f"{type(exc).__name__}: {exc}")
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
    result: list[tuple[str, int, int, str]] = []
    seen: set[int] = set()
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        if open_index in seen:
            continue
        seen.add(open_index)
        close_index = matching_brace(text, open_index)
        if close_index is None:
            continue
        result.append((match.group("id"), match.start(), close_index + 1, text[open_index + 1 : close_index]))
    return result


def identifiers(text: str) -> set[str]:
    return set(IDENTIFIER_RE.findall(text))


def source_groups(text: str) -> set[str]:
    return {
        group
        for group, patterns in SOURCE_PATTERNS.items()
        if any(pattern.search(text) for pattern in patterns)
    }


def assignment_graph(text: str) -> dict[str, dict[str, Any]]:
    graph: dict[str, dict[str, Any]] = {}
    for match in ASSIGNMENT_RE.finditer(text):
        name = match.group("name")
        rhs = match.group("rhs")[:900]
        graph[name] = {
            "rhs": rhs,
            "sources": set(source_groups(rhs)),
            "deps": identifiers(rhs),
        }
    for _ in range(7):
        changed = False
        for node in graph.values():
            before = set(node["sources"])
            for dep in node["deps"]:
                if dep in graph:
                    node["sources"].update(graph[dep]["sources"])
            if node["sources"] != before:
                changed = True
        if not changed:
            break
    return graph


def sentry_files(text: str) -> list[str]:
    found = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    found.update(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    return sorted(found)


def main() -> int:
    route_urls = [urllib.parse.urljoin(BASE, route) for route in ROUTES]
    discovered: set[str] = set()
    for url, (status, body, _error) in fetch_many(route_urls).items():
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

    candidates: list[dict[str, Any]] = []
    module_count = 0
    for script_url, text in scripts.items():
        vendor = any(value in script_url for value in ("framework", "webpack", "polyfills", "core-vendors"))
        for module_id, start, end, body in modules(text):
            module_count += 1
            if not any(pattern.search(body) for _, pattern in SINKS):
                continue
            graph = assignment_graph(body)
            module_sources = source_groups(body)
            source_files = sentry_files(body)
            for sink_name, pattern in SINKS:
                for match in pattern.finditer(body):
                    expr = (match.groupdict().get("expr") or "").strip()[:1600]
                    expr_sources = set(source_groups(expr))
                    aliases: dict[str, list[str]] = {}
                    for identifier in identifiers(expr):
                        if identifier in graph and graph[identifier]["sources"]:
                            values = sorted(graph[identifier]["sources"])
                            aliases[identifier] = values
                            expr_sources.update(values)
                    lo = max(0, match.start() - 2600)
                    hi = min(len(body), match.end() + 3400)
                    context = re.sub(r"\s+", " ", body[lo:hi])
                    validators = [pattern.pattern for pattern in VALIDATOR_PATTERNS if pattern.search(context)]
                    score = 8
                    reasons: list[str] = [f"sink={sink_name}"]
                    weights = {
                        "social_metadata": 52,
                        "token_metadata": 24,
                        "url_input": 55,
                        "api_response": 18,
                    }
                    module_weights = {
                        "social_metadata": 18,
                        "token_metadata": 8,
                        "url_input": 20,
                        "api_response": 6,
                    }
                    for group in sorted(expr_sources):
                        score += weights[group]
                        reasons.append(f"sink expression derives from {group}")
                    for group in sorted(module_sources - expr_sources):
                        score += module_weights[group]
                        reasons.append(f"same module contains {group}")
                    if source_files:
                        score += 12
                        reasons.append("application source metadata present")
                    if vendor:
                        score -= 28
                        reasons.append("vendor/framework chunk")
                    else:
                        score += 8
                    if validators:
                        score -= 30
                        reasons.append("URL validation/normalization indicator nearby")
                    else:
                        score += 10
                        reasons.append("no scheme validation indicator nearby")
                    if sink_name in {"window_open", "location_assign", "location_replace", "location_href", "location_direct"}:
                        score += 12
                    if sink_name == "react_href":
                        score -= 8
                    candidates.append(
                        {
                            "score": score,
                            "script_url": script_url,
                            "module_id": module_id,
                            "module_start": start,
                            "module_end": end,
                            "source_files": source_files,
                            "sink": sink_name,
                            "expression": expr,
                            "expression_sources": sorted(expr_sources),
                            "alias_sources": aliases,
                            "module_sources": sorted(module_sources),
                            "validators_in_context": validators,
                            "reasons": reasons,
                            "context": context,
                        }
                    )

    candidates.sort(key=lambda item: (-item["score"], item["script_url"], item["module_id"], item["sink"]))
    high_value = [
        candidate
        for candidate in candidates
        if candidate["score"] >= 70
        and (
            "social_metadata" in candidate["expression_sources"]
            or "url_input" in candidate["expression_sources"]
            or "social_metadata" in candidate["module_sources"]
        )
        and not candidate["validators_in_context"]
    ]
    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_scanned": module_count,
            "all_navigation_candidates": len(candidates),
            "high_value_candidates": len(high_value),
        },
        "high_value_candidates": high_value[:200],
        "top_candidates": candidates[:400],
    }
    out = Path("gmgn_url_navigation_sink_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for candidate in high_value[:80]:
        print(
            "CANDIDATE",
            json.dumps(
                {
                    "score": candidate["score"],
                    "script_url": candidate["script_url"],
                    "module_id": candidate["module_id"],
                    "source_files": candidate["source_files"],
                    "sink": candidate["sink"],
                    "expression": candidate["expression"][:700],
                    "expression_sources": candidate["expression_sources"],
                    "alias_sources": candidate["alias_sources"],
                    "module_sources": candidate["module_sources"],
                    "validators": candidate["validators_in_context"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

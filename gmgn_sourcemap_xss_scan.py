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
MAX_SCRIPTS = 280
MAX_SCRIPT_BYTES = 16_000_000
MAX_MAP_BYTES = 40_000_000
WORKERS = 16

REFERRAL_TERMS = (
    "bind_invite",
    "invite_info",
    "invite_code",
    "invited_code",
    "invited_address",
    "referral_code",
)

SINK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "react_dangerouslySetInnerHTML",
        re.compile(
            r"dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?P<expr>[^}\n]{1,700})",
            re.I,
        ),
    ),
    (
        "innerHTML_assignment",
        re.compile(r"\.innerHTML\s*=\s*(?P<expr>[^;\n]{1,700})", re.I),
    ),
    (
        "outerHTML_assignment",
        re.compile(r"\.outerHTML\s*=\s*(?P<expr>[^;\n]{1,700})", re.I),
    ),
    (
        "insertAdjacentHTML",
        re.compile(
            r"insertAdjacentHTML\s*\(\s*[^,]{1,100},\s*(?P<expr>[^)\n]{1,700})",
            re.I,
        ),
    ),
    (
        "document_write",
        re.compile(r"document\.write(?:ln)?\s*\(\s*(?P<expr>[^)\n]{1,700})", re.I),
    ),
    (
        "react_srcDoc",
        re.compile(r"srcDoc\s*=\s*\{\s*(?P<expr>[^}\n]{1,700})", re.I),
    ),
    (
        "createContextualFragment",
        re.compile(r"createContextualFragment\s*\(\s*(?P<expr>[^)\n]{1,700})", re.I),
    ),
    (
        "domparser_html",
        re.compile(
            r"parseFromString\s*\(\s*(?P<expr>[^,\n]{1,700}),\s*[\"']text/html[\"']",
            re.I,
        ),
    ),
    (
        "eval",
        re.compile(r"(?<![A-Za-z0-9_$])eval\s*\(\s*(?P<expr>[^)\n]{1,700})", re.I),
    ),
    (
        "new_Function",
        re.compile(r"new\s+Function\s*\(\s*(?P<expr>[^)\n]{1,700})", re.I),
    ),
    (
        "string_setTimeout",
        re.compile(r"setTimeout\s*\(\s*(?P<expr>[\"'`][^,\n]{1,700}),", re.I),
    ),
)

SOURCE_GROUPS: dict[str, tuple[re.Pattern[str], ...]] = {
    "url": (
        re.compile(r"(?:window\.)?location\.(?:search|hash|href|pathname)", re.I),
        re.compile(r"document\.(?:URL|documentURI|referrer)", re.I),
        re.compile(r"new\s+URLSearchParams\s*\(", re.I),
        re.compile(r"\bURLSearchParams\b", re.I),
        re.compile(r"\brouter\.(?:query|asPath|pathname)\b", re.I),
        re.compile(r"\buseSearchParams\s*\(", re.I),
        re.compile(r"\bsearchParams\.(?:get|getAll)\s*\(", re.I),
    ),
    "postmessage": (
        re.compile(r"addEventListener\s*\(\s*[\"']message[\"']", re.I),
        re.compile(r"\bonmessage\s*=", re.I),
        re.compile(r"\b(?:event|evt|messageEvent|e)\.data\b", re.I),
    ),
    "storage": (
        re.compile(r"\b(?:localStorage|sessionStorage)\b", re.I),
        re.compile(r"\.getItem\s*\(", re.I),
    ),
    "user_input": (
        re.compile(r"\b(?:event|evt|e)\.target\.value\b", re.I),
        re.compile(r"\bcurrentTarget\.value\b", re.I),
        re.compile(r"\bFormData\s*\(", re.I),
        re.compile(r"\bcontentEditable\b", re.I),
    ),
    "api_or_content": (
        re.compile(r"\b(?:response|resp|result|payload)\.(?:data|body)\b", re.I),
        re.compile(r"\bdata\.(?:html|content|description|message|bio|name|title|url)\b", re.I),
        re.compile(r"\b(?:html|content|description|markdown|message|bio|userContent)\b", re.I),
        re.compile(r"\b(?:invite_code|invited_code|referral_code|invite_info)\b", re.I),
    ),
}

SANITIZER_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bDOMPurify\b", re.I),
    re.compile(r"\bsanitize(?:Html|HTML)?\s*\(", re.I),
    re.compile(r"\bescape(?:Html|HTML)?\s*\(", re.I),
    re.compile(r"\bencodeURIComponent\s*\(", re.I),
    re.compile(r"\bhtmlEscape\b", re.I),
)


def fetch(url: str, max_bytes: int) -> tuple[int | None, dict[str, str], bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/javascript,application/json,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                body = body[:max_bytes]
            return (
                resp.status,
                {k.lower(): v for k, v in resp.headers.items()},
                body,
                None,
            )
    except urllib.error.HTTPError as exc:
        return (
            exc.code,
            {k.lower(): v for k, v in exc.headers.items()},
            exc.read(min(max_bytes, 200_000)),
            str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        return None, {}, b"", f"{type(exc).__name__}: {exc}"


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


def source_map_url(js_url: str, text: str) -> str:
    matches = re.findall(r"[#@]\s*sourceMappingURL=([^\s*]+)", text)
    if matches:
        return urllib.parse.urljoin(js_url, matches[-1].strip())
    return js_url.split("#", 1)[0] + ".map"


def source_signals(text: str) -> list[str]:
    signals: list[str] = []
    for group, patterns in SOURCE_GROUPS.items():
        if any(pattern.search(text) for pattern in patterns):
            signals.append(group)
    return signals


def sanitizer_signals(text: str) -> list[str]:
    return [pattern.pattern for pattern in SANITIZER_PATTERNS if pattern.search(text)]


def context_window(text: str, start: int, end: int, radius: int = 900) -> str:
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    return re.sub(r"\s+", " ", text[lo:hi])[:4_500]


def score_candidate(
    sink: str,
    expression: str,
    expression_sources: list[str],
    file_sources: list[str],
    sanitizers: list[str],
    source_file: str,
) -> tuple[int, list[str]]:
    score = 10
    reasons = [f"dangerous sink: {sink}"]

    direct_weights = {
        "url": 55,
        "postmessage": 50,
        "storage": 38,
        "user_input": 35,
        "api_or_content": 22,
    }
    file_weights = {
        "url": 20,
        "postmessage": 18,
        "storage": 12,
        "user_input": 12,
        "api_or_content": 7,
    }

    for source in expression_sources:
        score += direct_weights[source]
        reasons.append(f"source appears directly in sink expression: {source}")
    for source in file_sources:
        if source not in expression_sources:
            score += file_weights[source]
            reasons.append(f"same source file contains: {source}")

    if sanitizers:
        score -= 28
        reasons.append("sanitizer indicator present in local context")
    else:
        score += 8
        reasons.append("no sanitizer indicator in local context")

    if "node_modules" not in source_file and "webpack" not in source_file.lower():
        score += 8
        reasons.append("application source, not obvious vendor code")
    else:
        score -= 12
        reasons.append("vendor/framework source")

    if any(term in expression for term in REFERRAL_TERMS):
        score += 25
        reasons.append("referral field appears directly in sink expression")
    elif any(term in source_file.lower() for term in ("invite", "referral", "reward")):
        score += 5

    if sink in {"eval", "new_Function", "string_setTimeout"}:
        score += 10
    if sink in {"react_dangerouslySetInnerHTML", "innerHTML_assignment", "outerHTML_assignment"}:
        score += 8

    return score, reasons


def scan_source(source_file: str, content: str, map_url: str, script_url: str) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    candidates: list[dict[str, Any]] = []
    referral_hits = sorted({term for term in REFERRAL_TERMS if term in content})
    file_sources = source_signals(content)

    for sink_name, pattern in SINK_PATTERNS:
        for match in pattern.finditer(content):
            expression = (match.groupdict().get("expr") or "").strip()[:1_200]
            expression_sources = source_signals(expression)
            context = context_window(content, match.start(), match.end())
            sanitizers = sanitizer_signals(context)
            score, reasons = score_candidate(
                sink_name,
                expression,
                expression_sources,
                file_sources,
                sanitizers,
                source_file,
            )
            candidates.append(
                {
                    "score": score,
                    "source_file": source_file,
                    "script_url": script_url,
                    "map_url": map_url,
                    "sink": sink_name,
                    "expression": expression,
                    "expression_sources": expression_sources,
                    "file_sources": file_sources,
                    "sanitizers_in_context": sanitizers,
                    "referral_terms_in_file": referral_hits,
                    "reasons": reasons,
                    "context": context,
                }
            )

    referral_record = None
    if referral_hits:
        referral_record = {
            "source_file": source_file,
            "script_url": script_url,
            "map_url": map_url,
            "terms": referral_hits,
            "dangerous_sink_count": len(candidates),
            "source_signals": file_sources,
        }
    return candidates, referral_record


def fetch_many(urls: Iterable[str], max_bytes: int) -> dict[str, tuple[int | None, dict[str, str], bytes, str | None]]:
    url_list = list(dict.fromkeys(urls))
    out: dict[str, tuple[int | None, dict[str, str], bytes, str | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url, max_bytes): url for url in url_list}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                out[url] = future.result()
            except Exception as exc:  # noqa: BLE001
                out[url] = (None, {}, b"", f"{type(exc).__name__}: {exc}")
    return out


def main() -> int:
    route_urls = [urllib.parse.urljoin(BASE, route) for route in ROUTES]
    route_results = fetch_many(route_urls, 2_000_000)

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
        results = fetch_many(batch, MAX_SCRIPT_BYTES)
        for url, (status, _headers, body, _error) in results.items():
            if status != 200 or not body:
                continue
            text = body.decode("utf-8", errors="replace")
            script_bodies[url] = text
            for child in discover_js(text, url):
                if child not in script_bodies and len(script_bodies) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    map_targets = {source_map_url(url, text): url for url, text in script_bodies.items()}
    map_results = fetch_many(map_targets, MAX_MAP_BYTES)

    candidates: list[dict[str, Any]] = []
    referral_sources: list[dict[str, Any]] = []
    maps_parsed = 0
    source_files_scanned = 0
    map_failures: list[dict[str, Any]] = []

    for map_url, (status, _headers, body, error) in map_results.items():
        script_url = map_targets[map_url]
        if status != 200 or not body:
            map_failures.append({"map_url": map_url, "status": status, "error": error})
            continue
        try:
            source_map = json.loads(body.decode("utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            map_failures.append(
                {"map_url": map_url, "status": status, "error": f"invalid JSON: {exc}"}
            )
            continue

        sources = source_map.get("sources") or []
        contents = source_map.get("sourcesContent") or []
        if not isinstance(sources, list) or not isinstance(contents, list):
            continue
        maps_parsed += 1
        source_root = source_map.get("sourceRoot") or ""

        for index, content in enumerate(contents):
            if not isinstance(content, str) or not content:
                continue
            source_name = str(sources[index]) if index < len(sources) else f"source-{index}"
            source_file = urllib.parse.urljoin(source_root, source_name) if source_root else source_name
            source_files_scanned += 1
            found, referral = scan_source(source_file, content, map_url, script_url)
            candidates.extend(found)
            if referral:
                referral_sources.append(referral)

    candidates.sort(key=lambda item: (-item["score"], item["source_file"], item["sink"]))
    high_confidence = [
        candidate
        for candidate in candidates
        if candidate["expression_sources"] and candidate["score"] >= 70
    ]
    direct_url_to_sink = [
        candidate for candidate in candidates if "url" in candidate["expression_sources"]
    ]
    direct_message_to_sink = [
        candidate for candidate in candidates if "postmessage" in candidate["expression_sources"]
    ]
    direct_referral_to_sink = [
        candidate
        for candidate in candidates
        if any(term in candidate["expression"] for term in REFERRAL_TERMS)
    ]

    report = {
        "generated_at": int(time.time()),
        "scope": "unauthenticated public HTML, JavaScript and public source-map analysis only",
        "routes": sorted(route_summary, key=lambda item: item["url"]),
        "summary": {
            "scripts_fetched": len(script_bodies),
            "source_maps_requested": len(map_targets),
            "source_maps_parsed": maps_parsed,
            "source_files_scanned": source_files_scanned,
            "all_sink_candidates": len(candidates),
            "high_confidence_direct_source_candidates": len(high_confidence),
            "direct_url_to_sink_candidates": len(direct_url_to_sink),
            "direct_postmessage_to_sink_candidates": len(direct_message_to_sink),
            "direct_referral_to_sink_candidates": len(direct_referral_to_sink),
            "referral_source_files": len(referral_sources),
            "limitations": [
                "Static source-map analysis narrows real dataflow candidates but browser execution is still required for confirmation.",
                "No credentials, cookies, POST requests, state changes or injected payloads were used.",
                "Only public routes, scripts and source maps returned by GMGN were fetched.",
            ],
        },
        "high_confidence_candidates": high_confidence[:120],
        "direct_url_to_sink_candidates": direct_url_to_sink[:120],
        "direct_postmessage_to_sink_candidates": direct_message_to_sink[:120],
        "direct_referral_to_sink_candidates": direct_referral_to_sink[:120],
        "top_candidates": candidates[:250],
        "referral_sources": referral_sources[:250],
        "map_failures": map_failures[:250],
    }

    out = Path("gmgn_sourcemap_xss_report.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    for candidate in candidates[:40]:
        print(
            "CANDIDATE",
            json.dumps(
                {
                    "score": candidate["score"],
                    "source_file": candidate["source_file"],
                    "sink": candidate["sink"],
                    "expression": candidate["expression"][:300],
                    "expression_sources": candidate["expression_sources"],
                    "file_sources": candidate["file_sources"],
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

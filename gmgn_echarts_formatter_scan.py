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
MAX_SCRIPTS = 340
MAX_BYTES = 20_000_000
WORKERS = 16
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)
FORMATTER_RE = re.compile(r"formatter\s*:\s*(?P<expr>[^,}\n]{1,1400})", re.I)
TOKEN_TERMS = (
    "symbol",
    "token_name",
    "tokenName",
    "name",
    "token",
    "pair",
    "address",
    "ca",
    "logo",
    "description",
)
HTML_TERMS = ("<div", "<span", "<br", "<img", "<table", "<p", "</", "innerHTML")
ESCAPE_TERMS = ("encodeHTML", "escapeHTML", "escapeHtml", "sanitize", "DOMPurify", "encodeURIComponent")


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(MAX_BYTES), None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(200_000), str(exc)
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


def modules(text: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        close_index = matching_brace(text, open_index)
        if close_index is None:
            continue
        result.append((match.group("id"), text[open_index + 1 : close_index]))
    return result


def sentry_sources(text: str) -> list[str]:
    return sorted(
        set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
        | set(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    )


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

    findings: list[dict[str, Any]] = []
    module_count = 0
    for script_url, text in scripts.items():
        vendor_script = any(word in script_url for word in ("framework", "webpack", "polyfills", "7171-"))
        for module_id, body in modules(text):
            module_count += 1
            if "formatter" not in body or "tooltip" not in body:
                continue
            source_files = sentry_sources(body)
            for match in FORMATTER_RE.finditer(body):
                lo = max(0, match.start() - 4500)
                hi = min(len(body), match.end() + 6500)
                context = re.sub(r"\s+", " ", body[lo:hi])
                expr = match.group("expr").strip()
                token_terms = sorted({term for term in TOKEN_TERMS if term in context})
                html_terms = sorted({term for term in HTML_TERMS if term in context})
                escape_terms = sorted({term for term in ESCAPE_TERMS if term in context})
                score = 0
                reasons: list[str] = []
                if html_terms:
                    score += 35
                    reasons.append("HTML construction near formatter")
                if token_terms:
                    score += min(30, 4 * len(token_terms))
                    reasons.append("token/user metadata terms near formatter")
                if "tooltip" in context:
                    score += 10
                if source_files:
                    score += 15
                    reasons.append("application source metadata present")
                if vendor_script:
                    score -= 35
                    reasons.append("vendor/library script")
                else:
                    score += 10
                if escape_terms:
                    score -= 30
                    reasons.append("escaping/sanitization indicator present")
                if "return`" in context or "=>`" in context or "return\"<" in context or "return'<" in context:
                    score += 20
                    reasons.append("formatter appears to return HTML string")
                findings.append(
                    {
                        "score": score,
                        "script_url": script_url,
                        "module_id": module_id,
                        "source_files": source_files,
                        "expression": expr[:1600],
                        "token_terms": token_terms,
                        "html_terms": html_terms,
                        "escape_terms": escape_terms,
                        "reasons": reasons,
                        "context": context[:14_000],
                    }
                )

    findings.sort(key=lambda item: (-item["score"], item["script_url"], item["module_id"]))
    app_html_candidates = [
        finding
        for finding in findings
        if finding["score"] >= 45
        and finding["html_terms"]
        and not any(word in finding["script_url"] for word in ("7171-", "framework", "webpack", "polyfills"))
    ]
    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_scanned": module_count,
            "formatter_findings": len(findings),
            "app_html_candidates": len(app_html_candidates),
        },
        "app_html_candidates": app_html_candidates[:150],
        "top_findings": findings[:300],
    }
    out = Path("gmgn_echarts_formatter_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for finding in app_html_candidates[:60]:
        print(
            "CANDIDATE",
            json.dumps(
                {
                    "score": finding["score"],
                    "script_url": finding["script_url"],
                    "module_id": finding["module_id"],
                    "source_files": finding["source_files"],
                    "expression": finding["expression"][:500],
                    "token_terms": finding["token_terms"],
                    "html_terms": finding["html_terms"],
                    "escape_terms": finding["escape_terms"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
SOCIAL_TERMS = (
    "website",
    "website_url",
    "websiteUrl",
    "twitter",
    "twitter_url",
    "twitterUrl",
    "telegram",
    "telegram_url",
    "telegramUrl",
    "discord",
    "discord_url",
    "discordUrl",
    "social",
    "socials",
    "external_url",
    "externalUrl",
    "homepage",
    "token_link",
)
VALIDATION_TERMS = (
    "isSafeUrl",
    "safeUrl",
    "sanitizeUrl",
    "validateUrl",
    "startsWith(\"http",
    "startsWith('http",
    "new URL(",
    "javascript:",
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


def sentry_files(text: str) -> list[str]:
    output = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    output.update(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    return sorted(output)


def contexts(text: str, needle_pattern: re.Pattern[str], radius: int = 7000) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for match in needle_pattern.finditer(text):
        lo = max(0, match.start() - radius)
        hi = min(len(text), match.end() + radius)
        context = re.sub(r"\s+", " ", text[lo:hi])
        output.append(
            {
                "offset": match.start(),
                "match": match.group(0),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in context}),
                "validation_terms": sorted({term for term in VALIDATION_TERMS if term in context}),
                "context": context,
            }
        )
    return output


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

    records: list[dict[str, Any]] = []
    for script_url, text in scripts.items():
        for module_id, start, end, body in modules(text):
            if "978118" not in body:
                continue
            alias_matches = list(
                re.finditer(
                    r"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\(978118\)",
                    body,
                )
            )
            aliases = sorted({match.group("alias") for match in alias_matches})
            callsites: list[dict[str, Any]] = []
            for alias in aliases:
                patterns = (
                    re.compile(re.escape(alias) + r"\.Ay"),
                    re.compile(re.escape(alias) + r"\.default"),
                )
                for pattern in patterns:
                    callsites.extend(contexts(body, pattern))
            if aliases or "r(978118)" in body:
                records.append(
                    {
                        "script_url": script_url,
                        "module_id": module_id,
                        "module_start": start,
                        "module_end": end,
                        "bytes": len(body),
                        "source_files": sentry_files(body),
                        "aliases": aliases,
                        "module_social_terms": sorted({term for term in SOCIAL_TERMS if term in body}),
                        "module_validation_terms": sorted({term for term in VALIDATION_TERMS if term in body}),
                        "callsites": callsites,
                        "body": body if len(body) <= 180_000 else None,
                    }
                )

    records.sort(
        key=lambda record: (
            -sum(1 for call in record["callsites"] if call["social_terms"]),
            -len(record["callsites"]),
            record["script_url"],
            record["module_id"],
        )
    )
    high_value = [
        record
        for record in records
        if any(call["social_terms"] and not call["validation_terms"] for call in record["callsites"])
    ]
    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_importing_simulate_link": len(records),
            "high_value_modules": len(high_value),
            "callsites": sum(len(record["callsites"]) for record in records),
        },
        "high_value_modules": high_value,
        "records": records,
    }
    out = Path("gmgn_simulatelink_callsites.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for record in high_value:
        print(
            "MODULE",
            json.dumps(
                {
                    "script_url": record["script_url"],
                    "module_id": record["module_id"],
                    "source_files": record["source_files"],
                    "aliases": record["aliases"],
                    "module_social_terms": record["module_social_terms"],
                    "module_validation_terms": record["module_validation_terms"],
                    "callsite_count": len(record["callsites"]),
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        for callsite in record["callsites"][:20]:
            if callsite["social_terms"]:
                print(
                    "CALLSITE",
                    json.dumps(
                        {
                            "match": callsite["match"],
                            "social_terms": callsite["social_terms"],
                            "validation_terms": callsite["validation_terms"],
                            "context": callsite["context"][:3000],
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

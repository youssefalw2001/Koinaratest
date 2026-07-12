from __future__ import annotations

import concurrent.futures
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Iterable

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
TARGET_IDS = ("704108", "170051", "593862")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 340
MAX_BYTES = 20_000_000
WORKERS = 16


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


def extract_module(text: str, module_id: str) -> dict | None:
    pattern = re.compile(
        rf"(?:(?<=\{{)|(?<=,)){module_id}:(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{"
    )
    match = pattern.search(text)
    if not match:
        return None
    open_index = match.end() - 1
    close_index = matching_brace(text, open_index)
    if close_index is None:
        return {"module_id": module_id, "error": "closing brace not found"}
    body = text[open_index + 1 : close_index]
    return {
        "module_id": module_id,
        "start": match.start(),
        "end": close_index + 1,
        "bytes": len(body),
        "body": body,
    }


def main() -> int:
    route_urls = [urllib.parse.urljoin(BASE, route) for route in ROUTES]
    discovered: set[str] = set()
    for url, (status, body, _error) in fetch_many(route_urls).items():
        if status == 200:
            discovered.update(discover_js(body.decode("utf-8", errors="replace"), url))

    scripts: dict[str, str] = {}
    pending = set(discovered)
    found: dict[str, dict] = {}
    while pending and len(scripts) < MAX_SCRIPTS and len(found) < len(TARGET_IDS):
        batch = sorted(pending)[: min(40, MAX_SCRIPTS - len(scripts))]
        pending.difference_update(batch)
        for url, (status, body, _error) in fetch_many(batch).items():
            if status != 200 or not body:
                continue
            text = body.decode("utf-8", errors="replace")
            scripts[url] = text
            for module_id in TARGET_IDS:
                if module_id in found:
                    continue
                module = extract_module(text, module_id)
                if module:
                    found[module_id] = {"script_url": url, **module}
            for child in discover_js(text, url):
                if child not in scripts and len(scripts) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    report = {
        "scripts_fetched": len(scripts),
        "target_ids": TARGET_IDS,
        "found": found,
        "missing": [module_id for module_id in TARGET_IDS if module_id not in found],
    }
    out = Path("gmgn_community_producer_modules.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print("SCRIPTS_FETCHED", len(scripts))
    for module_id in TARGET_IDS:
        module = found.get(module_id)
        print("MODULE", module_id, "URL", module.get("script_url") if module else None, "BYTES", module.get("bytes") if module else None)
        if module:
            for value in sorted(set(re.findall(r'[\"\']([^\"\']{1,220})[\"\']', module["body"]))):
                if any(term in value.lower() for term in ("/api", "/tapi", "/xapi", "call_out", "community", "media", "upload")):
                    print("STRING", value)
    print("MISSING", report["missing"])
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

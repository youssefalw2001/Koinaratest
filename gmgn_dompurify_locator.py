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
ROUTES = ("/", "/login", "/trade", "/trenches", "/discover", "/rewards", "/profile", "/settings", "/sol", "/bsc")
TARGET_ID = "167587"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 380
MAX_BYTES = 24_000_000
WORKERS = 16


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(MAX_BYTES), None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(250_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def fetch_many(urls: Iterable[str]) -> dict[str, tuple[int | None, bytes, str | None]]:
    output = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url): url for url in dict.fromkeys(urls)}
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
    for pattern in (
        r"<script[^>]+src=[\"']([^\"']+)[\"']",
        r"[\"'](https?://[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"'](/_next/static/[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"']([^\"']+\.js(?:\?[^\"']*)?)[\"']",
    ):
        for match in re.finditer(pattern, text, flags=re.I):
            url = normalize_js_url(match.group(1), base_url)
            if url:
                found.add(url)
    return found


def find_matching_brace(text: str, open_index: int) -> int | None:
    depth = 0
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    index = open_index
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char in "\r\n": line_comment = False
            index += 1; continue
        if block_comment:
            if char == "*" and nxt == "/": block_comment = False; index += 2; continue
            index += 1; continue
        if quote:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == quote: quote = None
            index += 1; continue
        if char == "/" and nxt == "/": line_comment = True; index += 2; continue
        if char == "/" and nxt == "*": block_comment = True; index += 2; continue
        if char in {"'", '"', "`"}: quote = char; index += 1; continue
        if char == "{": depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0: return index
        index += 1
    return None


def extract_module(text: str) -> dict | None:
    pattern = re.compile(rf"(?:(?<=\{{)|(?<=,)){TARGET_ID}:(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{")
    match = pattern.search(text)
    if not match: return None
    open_index = match.end() - 1
    close_index = find_matching_brace(text, open_index)
    if close_index is None: return {"error": "closing brace not found"}
    body = text[open_index + 1 : close_index]
    version_patterns = (
        r"version\s*[:=]\s*[\"']([^\"']+)[\"']",
        r"DOMPurify\s+([0-9]+\.[0-9]+\.[0-9]+)",
        r"purify(?:\.min)?\.js[^0-9]{0,30}([0-9]+\.[0-9]+\.[0-9]+)",
    )
    versions = set()
    for version_pattern in version_patterns:
        versions.update(re.findall(version_pattern, body, flags=re.I))
    return {
        "module_id": TARGET_ID,
        "bytes": len(body),
        "versions": sorted(versions),
        "interesting_strings": sorted({
            value for value in re.findall(r'[\"\']([^\"\']{1,180})[\"\']', body)
            if any(term in value.lower() for term in ("version", "dompurify", "musu", "sanitize", "trusted", "svg", "mathml"))
        }),
        "body": body,
    }


def main() -> int:
    discovered: set[str] = set()
    for url, (status, body, _error) in fetch_many([urllib.parse.urljoin(BASE, route) for route in ROUTES]).items():
        if status == 200:
            discovered.update(discover_js(body.decode("utf-8", errors="replace"), url))
    scripts = {}
    pending = set(discovered)
    found = None
    while pending and len(scripts) < MAX_SCRIPTS and found is None:
        batch = sorted(pending)[: min(40, MAX_SCRIPTS - len(scripts))]
        pending.difference_update(batch)
        for url, (status, body, _error) in fetch_many(batch).items():
            if status != 200 or not body: continue
            text = body.decode("utf-8", errors="replace")
            scripts[url] = text
            module = extract_module(text)
            if module:
                found = {"script_url": url, **module}
                break
            for child in discover_js(text, url):
                if child not in scripts and len(scripts) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)
    report = {"scripts_fetched": len(scripts), "found": found}
    out = Path("gmgn_dompurify_module.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"scripts_fetched": len(scripts), "found": bool(found), "versions": found.get("versions") if found else None, "script_url": found.get("script_url") if found else None}, indent=2))
    if found:
        print("STRINGS", json.dumps(found["interesting_strings"], ensure_ascii=False))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

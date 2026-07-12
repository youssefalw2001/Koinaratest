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
    "/", "/login", "/trade", "/trenches", "/discover", "/portfolio",
    "/watchlist", "/rewards", "/profile", "/settings", "/sol", "/bsc",
)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 360
MAX_BYTES = 22_000_000
WORKERS = 16
TARGET_MODULE = "484811"
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
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


def modules(text: str) -> list[tuple[str, str]]:
    output: list[tuple[str, str]] = []
    seen: set[int] = set()
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        if open_index in seen: continue
        seen.add(open_index)
        close_index = matching_brace(text, open_index)
        if close_index is None: continue
        output.append((match.group("id"), text[open_index + 1:close_index]))
    return output


def contexts(text: str, pattern: re.Pattern[str], radius: int = 9000) -> list[dict[str, Any]]:
    output = []
    for match in pattern.finditer(text):
        lo = max(0, match.start() - radius)
        hi = min(len(text), match.end() + radius)
        ctx = re.sub(r"\s+", " ", text[lo:hi])
        output.append({
            "offset": match.start(),
            "match": match.group(0),
            "coolMode_present": "coolMode" in ctx,
            "coolMode_true": bool(re.search(r"coolMode\s*:\s*!?0?true|coolMode\s*:\s*!0", ctx)),
            "avatar_present": bool(re.search(r"avatar\s*:", ctx)),
            "context": ctx,
        })
    return output


def main() -> int:
    discovered: set[str] = set()
    for url, (status, body, _error) in fetch_many([urllib.parse.urljoin(BASE, route) for route in ROUTES]).items():
        if status == 200:
            discovered.update(discover_js(body.decode("utf-8", errors="replace"), url))

    scripts: dict[str, str] = {}
    pending = set(discovered)
    while pending and len(scripts) < MAX_SCRIPTS:
        batch = sorted(pending)[:min(40, MAX_SCRIPTS - len(scripts))]
        pending.difference_update(batch)
        for url, (status, body, _error) in fetch_many(batch).items():
            if status != 200 or not body: continue
            text = body.decode("utf-8", errors="replace")
            scripts[url] = text
            for child in discover_js(text, url):
                if child not in scripts and len(scripts) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    records = []
    for script_url, text in scripts.items():
        for module_id, body in modules(text):
            import_matches = list(re.finditer(
                rf"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\({TARGET_MODULE}\)",
                body,
            ))
            if not import_matches: continue
            aliases = sorted({match.group("alias") for match in import_matches})
            calls = []
            for alias in aliases:
                calls.extend(contexts(body, re.compile(re.escape(alias) + r"\.qL")))
            records.append({
                "script_url": script_url,
                "module_id": module_id,
                "aliases": aliases,
                "calls": calls,
                "module_has_coolMode": "coolMode" in body,
                "module_has_avatar": bool(re.search(r"avatar\s*:", body)),
                "body": body if len(body) <= 220_000 else None,
            })

    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "importing_modules": len(records),
            "provider_calls": sum(len(record["calls"]) for record in records),
            "calls_with_coolMode": sum(1 for record in records for call in record["calls"] if call["coolMode_present"]),
            "calls_with_coolMode_true": sum(1 for record in records for call in record["calls"] if call["coolMode_true"]),
            "calls_with_avatar": sum(1 for record in records for call in record["calls"] if call["avatar_present"]),
        },
        "records": records,
    }
    out = Path("gmgn_rainbowkit_provider_trace.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for record in records:
        print("MODULE", record["module_id"], record["script_url"], record["aliases"], len(record["calls"]))
        for call in record["calls"]:
            print("CALL", json.dumps({k: call[k] for k in ("match", "coolMode_present", "coolMode_true", "avatar_present")}, sort_keys=True))
            print(call["context"][:4000])
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
    "/", "/trenches", "/discover", "/trade", "/sol", "/portfolio",
    "/watchlist", "/rewards", "/profile", "/settings",
)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 360
MAX_BYTES = 22_000_000
WORKERS = 16
TARGET_MODULE = "933978"
TERMS = (
    "detail_url_pump",
    "PumpLivePreview",
    "PumpLiveIcon",
    "pump_live",
    "pumpfun",
    "pump.fun",
)
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,application/json,*/*;q=0.8"},
    )
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
    found = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    found.update(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    return sorted(found)


def endpoint_strings(text: str) -> list[str]:
    output: set[str] = set()
    for value in re.findall(r'["\']([^"\']{1,300})["\']', text):
        lower = value.lower()
        if value.startswith("/") and any(
            prefix in lower for prefix in ("/api", "/tapi", "/xapi", "/defi", "/quotation")
        ):
            output.add(value)
        elif any(term in lower for term in ("pump_live", "pumpfun", "pump.fun", "detail_url_pump")):
            output.add(value)
    return sorted(output)


def contexts(text: str, term: str, radius: int = 7000, limit: int = 60) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    start = 0
    while len(output) < limit:
        index = text.find(term, start)
        if index < 0:
            break
        lo = max(0, index - radius)
        hi = min(len(text), index + len(term) + radius)
        output.append({"offset": index, "context": re.sub(r"\s+", " ", text[lo:hi])})
        start = index + len(term)
    return output


def main() -> int:
    route_urls = [urllib.parse.urljoin(BASE, route) for route in ROUTES]
    discovered: set[str] = set()
    route_summary: list[dict[str, Any]] = []
    for url, (status, body, error) in fetch_many(route_urls).items():
        text = body.decode("utf-8", errors="replace")
        scripts = discover_js(text, url) if status == 200 else set()
        discovered.update(scripts)
        route_summary.append({"url": url, "status": status, "error": error, "scripts": len(scripts)})

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
    target_module: dict[str, Any] | None = None
    importers: list[dict[str, Any]] = []
    for script_url, text in scripts.items():
        for module_id, start, end, body in modules(text):
            term_counts = {term: body.count(term) for term in TERMS if term in body}
            if term_counts:
                record = {
                    "script_url": script_url,
                    "module_id": module_id,
                    "start": start,
                    "end": end,
                    "bytes": len(body),
                    "source_files": sentry_files(body),
                    "term_counts": term_counts,
                    "endpoints": endpoint_strings(body),
                    "contexts": {term: contexts(body, term) for term in term_counts},
                    "body": body if len(body) <= 220_000 else None,
                }
                records.append(record)
                if module_id == TARGET_MODULE:
                    target_module = record
            if re.search(rf"\b[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[A-Za-z_$][A-Za-z0-9_$]*\({TARGET_MODULE}\)", body):
                importers.append(
                    {
                        "script_url": script_url,
                        "module_id": module_id,
                        "source_files": sentry_files(body),
                        "endpoints": endpoint_strings(body),
                        "contexts": contexts(body, TARGET_MODULE),
                        "body": body if len(body) <= 250_000 else None,
                    }
                )

    records.sort(key=lambda item: (-sum(item["term_counts"].values()), item["script_url"], item["module_id"]))
    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_with_terms": len(records),
            "importers": len(importers),
            "target_found": target_module is not None,
        },
        "routes": route_summary,
        "target_module": target_module,
        "importers": importers,
        "records": records,
    }
    out = Path("gmgn_pump_url_trace.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    if target_module:
        print("TARGET", target_module["script_url"], target_module["source_files"], target_module["endpoints"])
    for importer in importers:
        print("IMPORTER", importer["module_id"], importer["script_url"], importer["source_files"], importer["endpoints"])
    for record in records:
        print("RECORD", record["module_id"], record["script_url"], record["source_files"], record["term_counts"], record["endpoints"])
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
TERMS = (
    "media_url",
    "mediaUrl",
    "poster_url",
    "posterUrl",
    "video_url",
    "videoUrl",
    "source_content",
    "twitter_media",
    "extended_entities",
    "attachments",
    "upload",
    "presign",
    "signed_url",
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


def contexts(text: str, term: str, radius: int = 4200, limit: int = 50) -> list[dict[str, Any]]:
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


def sentry_files(text: str) -> list[str]:
    patterns = (
        r'data-sentry-source-file:["\']([^"\']+)["\']',
        r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']',
    )
    found: set[str] = set()
    for pattern in patterns:
        found.update(re.findall(pattern, text))
    return sorted(found)


def endpoint_strings(text: str) -> list[str]:
    output: set[str] = set()
    for value in re.findall(r'["\']([^"\']{1,260})["\']', text):
        lower = value.lower()
        if (
            value.startswith("/")
            and any(prefix in lower for prefix in ("/api", "/tapi", "/xapi", "/defi", "/account", "/community"))
        ) or any(term in lower for term in ("upload", "presign", "media_url", "call_out")):
            output.add(value)
    return sorted(output)


def assignment_fragments(text: str) -> list[str]:
    patterns = (
        r"media_url\s*:\s*[^,}\n]{1,800}",
        r"mediaUrl\s*:\s*[^,}\n]{1,800}",
        r"(?:let|const|var)?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[^;\n]{0,600}media_url[^;\n]{0,600}",
        r"\.media_url\s*=\s*[^;\n]{1,800}",
        r"\.mediaUrl\s*=\s*[^;\n]{1,800}",
    )
    found: set[str] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            found.add(re.sub(r"\s+", " ", match.group(0))[:1600])
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

    records: list[dict[str, Any]] = []
    module_count = 0
    for script_url, text in scripts.items():
        for module_id, start, end, body in modules(text):
            module_count += 1
            hits = {term: body.count(term) for term in TERMS if term in body}
            if not hits:
                continue
            records.append(
                {
                    "script_url": script_url,
                    "module_id": module_id,
                    "module_start": start,
                    "module_end": end,
                    "bytes": len(body),
                    "sentry_files": sentry_files(body),
                    "term_counts": hits,
                    "endpoints": endpoint_strings(body),
                    "assignments": assignment_fragments(body),
                    "contexts": {
                        term: contexts(body, term)
                        for term in TERMS
                        if term in body
                    },
                    "body": body if len(body) <= 120_000 else None,
                }
            )

    records.sort(
        key=lambda record: (
            -record["term_counts"].get("media_url", 0),
            -sum(record["term_counts"].values()),
            record["script_url"],
            record["module_id"],
        )
    )
    report = {
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_scanned": module_count,
            "modules_with_media_terms": len(records),
            "media_url_occurrences": sum(record["term_counts"].get("media_url", 0) for record in records),
        },
        "records": records,
    }
    out = Path("gmgn_media_url_flow_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for record in records:
        print(
            "MODULE",
            json.dumps(
                {
                    "script_url": record["script_url"],
                    "module_id": record["module_id"],
                    "sentry_files": record["sentry_files"],
                    "term_counts": record["term_counts"],
                    "endpoints": record["endpoints"],
                    "assignments": record["assignments"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

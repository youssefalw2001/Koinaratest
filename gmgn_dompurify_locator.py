from __future__ import annotations

import concurrent.futures
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path
from typing import Iterable

BASE = "https://gmgn.ai/"
TARGET_ID = "167587"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MAX_SCRIPTS = 320
MAX_BYTES = 24_000_000
WORKERS = 16


def fetch(url: str, limit: int = MAX_BYTES) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/javascript,application/json,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(limit + 1)[:limit], None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(min(limit, 250_000)), str(exc)
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


def same_origin_js(raw: str, base_url: str) -> str | None:
    raw = html.unescape(raw).replace("\\/", "/")
    url = urllib.parse.urljoin(base_url, raw)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if parsed.hostname != "gmgn.ai":
        return None
    if not (parsed.path.endswith(".js") or ".js?" in url):
        return None
    return url


def discover_explicit_js(text: str, base_url: str) -> set[str]:
    found: set[str] = set()
    patterns = (
        r"<script[^>]+src=[\"']([^\"']+)[\"']",
        r"[\"'](https?://[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"'](/_next/static/[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"']([^\"']*(?:chunks|pages)/[^\"']+\.js(?:\?[^\"']*)?)[\"']",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            url = same_origin_js(match.group(1), base_url)
            if url:
                found.add(url)
    return found


def static_root(url: str) -> str:
    match = re.match(r"(https://gmgn\.ai/_next/static/)", url)
    return match.group(1) if match else urllib.parse.urljoin(url, "/_next/static/")


def discover_runtime_chunks(text: str, bundle_url: str) -> set[str]:
    root = static_root(bundle_url)
    found: set[str] = set()

    # Current GMGN Next.js runtime uses numeric chunk IDs with hex hashes,
    # producing URLs shaped like /_next/static/chunks/9601-<hash>.js.
    for chunk_id, digest in re.findall(
        r"(?<![A-Za-z0-9_$])([0-9]{2,7})\s*:\s*[\"']([a-f0-9]{8,40})[\"']",
        text,
        flags=re.I,
    ):
        found.add(urllib.parse.urljoin(root, f"chunks/{chunk_id}-{digest}.js"))

    # Some builds include the complete filename in the mapping value.
    for chunk_id, filename in re.findall(
        r"(?<![A-Za-z0-9_$])([0-9]{2,7})\s*:\s*[\"']([^\"']+\.js)[\"']",
        text,
        flags=re.I,
    ):
        del chunk_id
        url = same_origin_js(filename, root)
        if url:
            found.add(url)

    return found


def discover_manifest_scripts(page: str) -> tuple[list[str], list[dict]]:
    candidates: set[str] = set()
    manifest_records: list[dict] = []
    manifest_patterns = (
        r"[\"'](/_next/static/[^\"']+/_buildManifest\.js)[\"']",
        r"[\"'](/_next/static/[^\"']+/_ssgManifest\.js)[\"']",
        r"[\"'](/_next/static/[^\"']+/_middlewareManifest\.js)[\"']",
    )
    manifest_urls: set[str] = set()
    for pattern in manifest_patterns:
        manifest_urls.update(
            urllib.parse.urljoin(BASE, match.group(1))
            for match in re.finditer(pattern, page, flags=re.I)
        )

    for url, (status, body, error) in fetch_many(sorted(manifest_urls)).items():
        text = body.decode("utf-8", errors="replace")
        scripts = discover_explicit_js(text, url) if status == 200 else set()
        candidates.update(scripts)
        manifest_records.append(
            {
                "url": url,
                "status": status,
                "error": error,
                "bytes": len(body),
                "scripts": len(scripts),
            }
        )
    return sorted(candidates), manifest_records


def find_matching_brace(text: str, open_index: int) -> int | None:
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


def extract_module(text: str) -> dict | None:
    pattern = re.compile(
        rf"(?:(?<=\{{)|(?<=,)){TARGET_ID}:"
        rf"(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{"
    )
    match = pattern.search(text)
    if not match:
        return None
    open_index = match.end() - 1
    close_index = find_matching_brace(text, open_index)
    if close_index is None:
        return {"error": "closing brace not found"}
    body = text[open_index + 1 : close_index]

    semvers = sorted(
        set(
            re.findall(
                r"(?<![0-9])([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,3})(?![0-9])",
                body,
            )
        )
    )
    explicit_versions = sorted(
        set(
            re.findall(
                r"(?:version|VERSION)\s*[:=]\s*[\"']([^\"']+)[\"']",
                body,
                flags=re.I,
            )
        )
    )
    strings = sorted(
        {
            value
            for value in re.findall(r'[\"\']([^\"\']{1,220})[\"\']', body)
            if any(
                term in value.lower()
                for term in (
                    "version",
                    "dompurify",
                    "sanitize",
                    "trusted",
                    "svg",
                    "mathml",
                    "musu",
                    "removed",
                    "isSupported",
                )
            )
        }
    )
    return {
        "module_id": TARGET_ID,
        "bytes": len(body),
        "semver_strings": semvers,
        "explicit_versions": explicit_versions,
        "interesting_strings": strings,
        "body": body,
    }


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 4_000_000)
    page = root_body.decode("utf-8", errors="replace")

    initial = discover_explicit_js(page, BASE)
    manifest_scripts, manifest_records = discover_manifest_scripts(page)
    queue = deque(sorted(initial | set(manifest_scripts)))
    queued = set(queue)
    visited: dict[str, dict] = {}
    found: dict | None = None

    while queue and len(visited) < MAX_SCRIPTS and found is None:
        batch: list[str] = []
        while queue and len(batch) < WORKERS and len(visited) + len(batch) < MAX_SCRIPTS:
            url = queue.popleft()
            if url not in visited:
                batch.append(url)
        if not batch:
            break

        for url, (status, body, error) in fetch_many(batch).items():
            text = body.decode("utf-8", errors="replace")
            visited[url] = {
                "status": status,
                "error": error,
                "bytes": len(body),
            }
            if status != 200 or not body:
                continue

            module = extract_module(text)
            if module:
                found = {"script_url": url, **module}
                break

            children = discover_explicit_js(text, url) | discover_runtime_chunks(text, url)
            for child in sorted(children):
                if child not in visited and child not in queued and len(queued) < MAX_SCRIPTS * 4:
                    queued.add(child)
                    queue.append(child)

    report = {
        "root": {
            "status": root_status,
            "error": root_error,
            "bytes": len(root_body),
            "initial_scripts": len(initial),
        },
        "manifests": manifest_records,
        "scripts_requested": len(visited),
        "successful_scripts": sum(1 for item in visited.values() if item["status"] == 200),
        "queued_total": len(queued),
        "found": found,
        "visited": visited,
    }
    out = Path("gmgn_dompurify_module.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        json.dumps(
            {
                "root_status": root_status,
                "initial_scripts": len(initial),
                "manifest_scripts": len(manifest_scripts),
                "scripts_requested": len(visited),
                "successful_scripts": report["successful_scripts"],
                "queued_total": len(queued),
                "found": found is not None,
                "script_url": found.get("script_url") if found else None,
                "bytes": found.get("bytes") if found else None,
                "semver_strings": found.get("semver_strings") if found else None,
                "explicit_versions": found.get("explicit_versions") if found else None,
            },
            indent=2,
        )
    )
    if found:
        print("STRINGS", json.dumps(found["interesting_strings"], ensure_ascii=False))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

BASE = "https://gmgn.ai/"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
TARGET = "461617"
MAX_BUNDLES = 260
MAX_BYTES = 20_000_000


def fetch(url: str, limit: int = MAX_BYTES) -> tuple[int | None, bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            return response.status, response.read(limit + 1)[:limit], None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(min(limit, 250_000)), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def scripts(text: str, base: str) -> list[str]:
    output: set[str] = set()
    for pattern in (
        r'<script[^>]+src=["\']([^"\']+)["\']',
        r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']',
    ):
        for match in re.finditer(pattern, text, re.I):
            url = urllib.parse.urljoin(base, html.unescape(match.group(1)))
            parsed = urllib.parse.urlparse(url)
            if parsed.hostname == "gmgn.ai" and (
                parsed.path.endswith(".js") or ".js?" in url
            ):
                output.add(url)
    return sorted(output)


def manifest(page: str) -> tuple[str | None, dict[str, list[str]]]:
    match = re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']', page)
    if not match:
        return None, {}
    url = urllib.parse.urljoin(BASE, match.group(1))
    status, body, _error = fetch(url, 5_000_000)
    if status != 200:
        return url, {}
    text = body.decode("utf-8", errors="replace")
    routes: dict[str, list[str]] = {}
    for route in re.finditer(r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]', text):
        files = re.findall(r'["\']([^"\']+\.js)["\']', route.group(2))
        if files:
            routes[route.group(1)] = [urllib.parse.urljoin(url, item) for item in files]
    return url, routes


def chunks(text: str, url: str) -> set[str]:
    output = {
        urllib.parse.urljoin(url, item)
        for item in re.findall(
            r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']', text
        )
    }
    root = re.match(r"(https://[^/]+/_next/static/)", url)
    base = root.group(1) if root else urllib.parse.urljoin(url, "/_next/static/")
    for chunk_id, digest in re.findall(
        r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']', text, re.I
    ):
        output.add(urllib.parse.urljoin(base, f"chunks/{chunk_id}-{digest}.js"))
    return output


def modules(text: str) -> list[tuple[str, int, str]]:
    starts = list(
        re.finditer(
            r"(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|\w+)\s*=>\s*\{",
            text,
        )
    )
    if not starts:
        starts = list(
            re.finditer(
                r"(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{",
                text,
            )
        )
    if not starts:
        return [("whole", 0, text)]
    output: list[tuple[str, int, str]] = []
    for index, match in enumerate(starts):
        start = match.start(1)
        end = starts[index + 1].start(1) if index + 1 < len(starts) else len(text)
        if 120 < end - start < 2_000_000:
            output.append((match.group(1), start, text[start:end]))
    return output


def source_files(text: str) -> list[str]:
    output = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    output.update(
        re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text)
    )
    return sorted(output)


def api_strings(text: str) -> list[str]:
    output: set[str] = set()
    for value in re.findall(r'["\']([^"\']{1,260})["\']', text):
        if value.startswith("/") and any(
            prefix in value.lower()
            for prefix in ("/api", "/tapi", "/xapi", "/defi", "/account", "/rebate")
        ):
            output.add(value)
    return sorted(output)


def prop_fields(context: str) -> list[str]:
    fields = set(
        re.findall(
            r"\.([A-Za-z_$][A-Za-z0-9_$]{1,80})\b",
            context,
        )
    )
    important = {
        field
        for field in fields
        if any(
            term in field.lower()
            for term in (
                "html",
                "content",
                "description",
                "message",
                "text",
                "bio",
                "thesis",
                "notice",
                "announcement",
                "markdown",
                "tooltip",
                "summary",
                "reason",
                "title",
                "name",
                "symbol",
            )
        )
    }
    return sorted(important)


def contexts_for_alias(text: str, alias: str, radius: int = 7000) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    patterns = (
        re.compile(re.escape(alias) + r"\.A"),
        re.compile(re.escape(alias) + r"\.default"),
    )
    seen: set[int] = set()
    for pattern in patterns:
        for match in pattern.finditer(text):
            if match.start() in seen:
                continue
            seen.add(match.start())
            low = max(0, match.start() - radius)
            high = min(len(text), match.end() + radius)
            context = re.sub(r"\s+", " ", text[low:high])
            output.append(
                {
                    "offset": match.start(),
                    "match": match.group(0),
                    "fields": prop_fields(context),
                    "has_dangerous_html": "dangerouslySetInnerHTML" in context,
                    "has_dompurify": "DOMPurify" in context,
                    "context": context,
                }
            )
    return output


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 3_000_000)
    page = root_body.decode("utf-8", errors="replace")
    manifest_url, routes = manifest(page)
    queue = scripts(page, BASE)
    for files in routes.values():
        queue.extend(files)

    seen: set[str] = set()
    records: list[dict[str, Any]] = []
    importer_modules = 0

    while queue and len(seen) < MAX_BUNDLES:
        url = queue.pop(0)
        if url in seen or not url.startswith("https://gmgn.ai/"):
            continue
        seen.add(url)
        status, body, _error = fetch(url)
        if status != 200 or not body:
            continue
        text = body.decode("utf-8", errors="replace")
        queue.extend(item for item in chunks(text, url) if item not in seen)

        for module_id, start, module in modules(text):
            if TARGET not in module:
                continue
            import_matches = list(
                re.finditer(
                    rf"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*"
                    rf"[A-Za-z_$][A-Za-z0-9_$]*\({TARGET}\)",
                    module,
                )
            )
            aliases = sorted({match.group("alias") for match in import_matches})
            if not aliases:
                continue
            importer_modules += 1
            calls: list[dict[str, Any]] = []
            for alias in aliases:
                calls.extend(contexts_for_alias(module, alias))
            records.append(
                {
                    "bundle": url,
                    "module_id": module_id,
                    "module_start": start,
                    "module_bytes": len(module),
                    "source_files": source_files(module),
                    "aliases": aliases,
                    "api_strings": api_strings(module),
                    "calls": calls,
                    "body": module if len(module) <= 300_000 else None,
                }
            )
        time.sleep(0.08)

    records.sort(
        key=lambda record: (
            -len(record["calls"]),
            record["bundle"],
            record["module_id"],
        )
    )
    report = {
        "scope": "unauthenticated static analysis of public GMGN chunks",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "summary": {
            "bundles_seen": len(seen),
            "importer_modules": importer_modules,
            "render_calls": sum(len(record["calls"]) for record in records),
        },
        "records": records,
    }
    out = Path("gmgn_html_component_callsites.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    for record in records:
        print(
            "MODULE",
            json.dumps(
                {
                    "bundle": record["bundle"],
                    "module_id": record["module_id"],
                    "source_files": record["source_files"],
                    "aliases": record["aliases"],
                    "api_strings": record["api_strings"],
                    "calls": len(record["calls"]),
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        for call in record["calls"][:20]:
            print(
                "CALL",
                json.dumps(
                    {
                        "match": call["match"],
                        "fields": call["fields"],
                        "has_dangerous_html": call["has_dangerous_html"],
                        "has_dompurify": call["has_dompurify"],
                        "context": call["context"][:4500],
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                ),
            )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
MARKERS = ("TokenSocial.tsx", "SocialInfo.tsx", "TwitterName.tsx")
MAX_BUNDLES = 280
MAX_BYTES = 24_000_000
MODULE_START_RE = re.compile(
    r"(?:^|[,{}])(?P<id>[0-9]{2,8})\s*[:=]\s*"
    r"(?:(?:function\s*)?\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*"
    r"(?:=>)?\s*\{"
)
SINK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("window_open", re.compile(r"window\.open\s*\(\s*(?P<expr>[^,\)\n]{1,1600})", re.I)),
    ("location_assign", re.compile(r"location\.assign\s*\(\s*(?P<expr>[^\)\n]{1,1600})", re.I)),
    ("location_replace", re.compile(r"location\.replace\s*\(\s*(?P<expr>[^\)\n]{1,1600})", re.I)),
    ("location_href", re.compile(r"location\.href\s*=\s*(?P<expr>[^;\n]{1,1600})", re.I)),
    ("href_prop", re.compile(r"\bhref\s*:\s*(?P<expr>[^,}\n]{1,1600})", re.I)),
    ("src_prop", re.compile(r"\bsrc\s*:\s*(?P<expr>[^,}\n]{1,1600})", re.I)),
)
SOCIAL_TERMS = (
    "website", "website_url", "websiteUrl", "twitter", "twitter_url", "twitterUrl",
    "telegram", "telegram_url", "telegramUrl", "discord", "discord_url", "discordUrl",
    "social", "socials", "external_url", "externalUrl", "homepage", "link", "url",
)
VALIDATOR_TERMS = (
    "isSafeUrl", "safeUrl", "sanitizeUrl", "validateUrl", "normalizeUrl",
    "startsWith(\"http", "startsWith('http", "new URL(", "URL.canParse",
    "javascript:", "data:", "vbscript:",
)


def fetch(url: str, limit: int = MAX_BYTES) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
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
        r'(\d{2,7})\s*:\s*["\']([a-f0-9]{8,40})["\']', text, re.I
    ):
        output.add(urllib.parse.urljoin(base, f"chunks/{chunk_id}-{digest}.js"))
    return output


def modules(text: str) -> list[tuple[str, int, int, str]]:
    starts = list(MODULE_START_RE.finditer(text))
    if not starts:
        return [("whole", 0, len(text), text)]
    output: list[tuple[str, int, int, str]] = []
    for index, match in enumerate(starts):
        start = match.start("id")
        end = starts[index + 1].start("id") if index + 1 < len(starts) else len(text)
        if 120 < end - start < 3_000_000:
            output.append((match.group("id"), start, end, text[start:end]))
    return output


def source_files(text: str) -> list[str]:
    output = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    output.update(
        re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text)
    )
    return sorted(output)


def marker_sections(module: str) -> list[dict[str, Any]]:
    matches: list[tuple[str, int]] = []
    for marker in MARKERS:
        matches.extend((marker, match.start()) for match in re.finditer(re.escape(marker), module))
    matches.sort(key=lambda item: item[1])
    output: list[dict[str, Any]] = []
    for index, (marker, position) in enumerate(matches):
        low = max(0, position - 18_000)
        high = min(len(module), position + 65_000)
        if index + 1 < len(matches):
            high = min(high, matches[index + 1][1] + 18_000)
        body = module[low:high]
        output.append(
            {
                "marker": marker,
                "offset": position,
                "start": low,
                "end": high,
                "bytes": len(body),
                "source_files": source_files(body),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in body}),
                "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in body}),
                "body": body,
            }
        )
    return output


def sink_records(section: dict[str, Any]) -> list[dict[str, Any]]:
    body = section["body"]
    output: list[dict[str, Any]] = []
    for sink_name, pattern in SINK_PATTERNS:
        for match in pattern.finditer(body):
            low = max(0, match.start() - 7000)
            high = min(len(body), match.end() + 7000)
            context = re.sub(r"\s+", " ", body[low:high])
            output.append(
                {
                    "sink": sink_name,
                    "offset": section["start"] + match.start(),
                    "expression": (match.groupdict().get("expr") or "").strip(),
                    "social_terms": sorted({term for term in SOCIAL_TERMS if term in context}),
                    "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in context}),
                    "source_files": source_files(context),
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

    while queue and len(seen) < MAX_BUNDLES:
        url = queue.pop(0)
        if url in seen or not url.startswith("https://gmgn.ai/"):
            continue
        seen.add(url)
        status, body, error = fetch(url)
        if status != 200 or not body:
            continue
        text = body.decode("utf-8", errors="replace")
        queue.extend(item for item in chunks(text, url) if item not in seen)
        if not any(marker in text for marker in MARKERS):
            time.sleep(0.05)
            continue
        for module_id, start, end, module in modules(text):
            found_markers = [marker for marker in MARKERS if marker in module]
            if not found_markers:
                continue
            sections = marker_sections(module)
            for section in sections:
                section["sinks"] = sink_records(section)
            records.append(
                {
                    "bundle": url,
                    "status": status,
                    "error": error,
                    "module_id": module_id,
                    "module_start": start,
                    "module_end": end,
                    "module_bytes": len(module),
                    "source_files": source_files(module),
                    "markers": found_markers,
                    "sections": sections,
                    "module": module if len(module) <= 1_000_000 else None,
                }
            )
        time.sleep(0.05)

    sink_count = sum(
        len(section["sinks"])
        for record in records
        for section in record["sections"]
    )
    high_value = [
        {"bundle": record["bundle"], "module_id": record["module_id"], **sink}
        for record in records
        for section in record["sections"]
        for sink in section["sinks"]
        if any(
            term in sink["social_terms"]
            for term in ("website", "website_url", "websiteUrl", "twitter", "telegram", "discord", "socials")
        )
    ]

    report = {
        "scope": "unauthenticated public runtime-chunk analysis",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "summary": {
            "bundles_seen": len(seen),
            "modules_found": len(records),
            "sections_found": sum(len(record["sections"]) for record in records),
            "sink_records": sink_count,
            "high_value_sinks": len(high_value),
        },
        "high_value_sinks": high_value,
        "records": records,
    }
    out = Path("gmgn_tokensocial_runtime_locator.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    for record in records:
        print(
            "MODULE",
            json.dumps(
                {
                    "bundle": record["bundle"],
                    "module_id": record["module_id"],
                    "module_bytes": record["module_bytes"],
                    "source_files": record["source_files"],
                    "markers": record["markers"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        for section in record["sections"]:
            print(
                "SECTION",
                json.dumps(
                    {
                        "marker": section["marker"],
                        "source_files": section["source_files"],
                        "social_terms": section["social_terms"],
                        "validator_terms": section["validator_terms"],
                        "sinks": len(section["sinks"]),
                    },
                    ensure_ascii=False,
                    sort_keys=True,
                ),
            )
            print(re.sub(r"\s+", " ", section["body"])[:12000])
            for sink in section["sinks"]:
                print(
                    "SINK",
                    json.dumps(
                        {
                            "sink": sink["sink"],
                            "expression": sink["expression"][:1200],
                            "social_terms": sink["social_terms"],
                            "validator_terms": sink["validator_terms"],
                            "source_files": sink["source_files"],
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

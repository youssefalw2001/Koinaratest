from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

BASE = "https://gmgn.ai/"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_BUNDLES = 420
MAX_BYTES = 22_000_000
NEEDLES = (
    "twitter/oauth_url",
    "r(582551)",
    ".WC(",
    "FollowTwitter",
    "track_the_wallet_of_you_twitter_friends",
    "fromurl:",
    "before:",
    "bind_address:",
    "storeCurrentUrlInLocalStorage",
    "window.location.href=",
    "window.open(",
)


def fetch(url: str, limit: int = MAX_BYTES):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(limit + 1)[:limit], None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(200_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def script_urls(text: str, base_url: str) -> set[str]:
    output: set[str] = set()
    for pattern in (
        r'<script[^>]+src=["\']([^"\']+)["\']',
        r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']',
    ):
        for match in re.finditer(pattern, text, re.I):
            url = urllib.parse.urljoin(base_url, html.unescape(match.group(1)))
            parsed = urllib.parse.urlparse(url)
            if url.startswith("https://gmgn.ai/") and (
                parsed.path.endswith(".js") or ".js?" in url
            ):
                output.add(url)
    return output


def manifest_routes(text: str):
    match = re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']', text)
    if not match:
        return None, {}
    url = urllib.parse.urljoin(BASE, match.group(1))
    status, body, _ = fetch(url, 8_000_000)
    if status != 200:
        return url, {}
    source = body.decode(errors="replace")
    routes: dict[str, list[str]] = {}
    for item in re.finditer(
        r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]', source
    ):
        chunks = re.findall(r'["\']([^"\']+\.js)["\']', item.group(2))
        if chunks:
            routes[item.group(1)] = [urllib.parse.urljoin(url, chunk) for chunk in chunks]
    return url, routes


def dynamic_chunks(text: str, url: str) -> set[str]:
    output = {
        urllib.parse.urljoin(url, value)
        for value in re.findall(
            r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']', text
        )
    }
    root = re.match(r"(https://[^/]+/_next/static/)", url)
    base = root.group(1) if root else urllib.parse.urljoin(url, "/_next/static/")
    for number, digest in re.findall(
        r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']', text
    ):
        output.add(urllib.parse.urljoin(base, f"chunks/{number}-{digest}.js"))
    return output


def snippets(text: str, needle: str, radius: int = 14_000, limit: int = 80):
    output = []
    start = 0
    while len(output) < limit:
        index = text.find(needle, start)
        if index < 0:
            break
        output.append(
            {
                "offset": index,
                "snippet": re.sub(
                    r"\s+",
                    " ",
                    text[max(0, index - radius) : min(len(text), index + len(needle) + radius)],
                ),
            }
        )
        start = index + len(needle)
    return output


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 3_000_000)
    page = root_body.decode(errors="replace")
    manifest_url, routes = manifest_routes(page)
    queue = deque(script_urls(page, BASE))
    for values in routes.values():
        queue.extend(values)

    seen: set[str] = set()
    hits = []
    while queue and len(seen) < MAX_BUNDLES:
        url = queue.popleft()
        if url in seen or not url.startswith("https://gmgn.ai/"):
            continue
        seen.add(url)
        status, body, error = fetch(url)
        if status != 200 or not body:
            continue
        text = body.decode(errors="replace")
        queue.extend(item for item in dynamic_chunks(text, url) if item not in seen)
        needle_hits = {}
        for needle in NEEDLES:
            found = snippets(text, needle)
            if found:
                needle_hits[needle] = found
        if needle_hits:
            hits.append(
                {
                    "url": url,
                    "bytes": len(body),
                    "needles": needle_hits,
                }
            )
        time.sleep(0.05)

    report = {
        "generated_at": int(time.time()),
        "scope": "Public static literal extraction for current Twitter OAuth helper callers",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "bundles_scanned": len(seen),
        "needles": list(NEEDLES),
        "bundles_with_hits": len(hits),
        "hits": hits,
        "summary": {
            "bundles": len(seen),
            "bundles_with_hits": len(hits),
            "literal_counts": {
                needle: sum(
                    len(bundle["needles"].get(needle, [])) for bundle in hits
                )
                for needle in NEEDLES
            },
        },
        "candidates": [],
        "canaries": [],
    }
    Path("gmgn_xss_focus_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    lines = [
        "# GMGN Current Twitter OAuth Caller Trace",
        "",
        f"Bundles scanned: **{len(seen)}**",
        f"Bundles with hits: **{len(hits)}**",
        "",
    ]
    for needle, count in report["summary"]["literal_counts"].items():
        lines.append(f"- `{needle}`: {count}")
    Path("gmgn_xss_focus_verdict.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(report["summary"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

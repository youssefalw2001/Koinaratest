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

TARGETS = (
    "bind_invite",
    "invite_info",
    "invite_code",
    "invited_code",
    "referral_code",
    "dangerouslySetInnerHTML",
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "DOMParser",
    "DOMPurify",
    "sanitize",
    "localStorage",
    "account_token_",
    "access_token",
    "refresh_token",
    "trade_token",
)

SOURCES = ("invite_code", "invited_code", "referral_code", "invite_info", "bind_invite")
SINKS = (
    "dangerouslySetInnerHTML",
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "DOMParser",
)
SANITIZERS = ("DOMPurify", "sanitize", "escapeHTML", "encodeURIComponent")

MAX_BUNDLES = 120
MAX_BYTES = 12_000_000
WINDOW = 900


def fetch(url: str) -> tuple[int | None, dict[str, str], bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/javascript,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                body = body[:MAX_BYTES]
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, headers, body, None
    except urllib.error.HTTPError as exc:
        body = exc.read(100_000)
        return exc.code, {k.lower(): v for k, v in exc.headers.items()}, body, str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, {}, b"", f"{type(exc).__name__}: {exc}"


def script_urls(page: str, base_url: str) -> list[str]:
    found: set[str] = set()
    patterns = (
        r'<script[^>]+src=["\']([^"\']+)["\']',
        r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']',
        r'["\'](/_next/static/[^"\']+)["\']',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, page, flags=re.I):
            raw = html.unescape(match.group(1))
            url = urllib.parse.urljoin(base_url, raw)
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme in {"http", "https"} and (
                parsed.path.endswith(".js") or ".js?" in url
            ):
                found.add(url)
    return sorted(found)[:MAX_BUNDLES]


def windows(text: str, needle: str, limit: int = 12) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    start = 0
    while len(out) < limit:
        idx = text.find(needle, start)
        if idx < 0:
            break
        lo = max(0, idx - WINDOW)
        hi = min(len(text), idx + len(needle) + WINDOW)
        out.append(
            {
                "offset": idx,
                "snippet": re.sub(r"\s+", " ", text[lo:hi]),
            }
        )
        start = idx + len(needle)
    return out


def proximity_findings(text: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    source_hits = [(s, m.start()) for s in SOURCES for m in re.finditer(re.escape(s), text)]
    sink_hits = [(s, m.start()) for s in SINKS for m in re.finditer(re.escape(s), text)]
    sanitizer_hits = [(s, m.start()) for s in SANITIZERS for m in re.finditer(re.escape(s), text)]

    for source, source_pos in source_hits[:200]:
        for sink, sink_pos in sink_hits:
            if abs(sink_pos - source_pos) > 12_000:
                continue
            lo = max(0, min(source_pos, sink_pos) - 1_500)
            hi = min(len(text), max(source_pos, sink_pos) + 1_500)
            nearby_sanitizers = sorted(
                {
                    sanitizer
                    for sanitizer, sanitizer_pos in sanitizer_hits
                    if lo <= sanitizer_pos <= hi
                }
            )
            findings.append(
                {
                    "source": source,
                    "source_offset": source_pos,
                    "sink": sink,
                    "sink_offset": sink_pos,
                    "distance": abs(sink_pos - source_pos),
                    "sanitizers_in_window": nearby_sanitizers,
                    "snippet": re.sub(r"\s+", " ", text[lo:hi]),
                }
            )
    findings.sort(key=lambda item: item["distance"])
    return findings[:80]


def main() -> int:
    status, headers, body, error = fetch(BASE)
    page = body.decode("utf-8", errors="replace")
    urls = script_urls(page, BASE)

    report: dict[str, Any] = {
        "generated_at": int(time.time()),
        "scope": "unauthenticated public frontend static analysis only",
        "root": {
            "url": BASE,
            "status": status,
            "error": error,
            "bytes": len(body),
            "content_type": headers.get("content-type"),
            "content_security_policy": headers.get("content-security-policy"),
            "content_security_policy_report_only": headers.get(
                "content-security-policy-report-only"
            ),
            "x_content_type_options": headers.get("x-content-type-options"),
            "referrer_policy": headers.get("referrer-policy"),
        },
        "bundle_urls": urls,
        "bundles": [],
        "summary": {},
    }

    aggregate_counts = {target: 0 for target in TARGETS}
    proximity_total = 0

    for index, url in enumerate(urls, start=1):
        print(f"[{index}/{len(urls)}] GET {url}", flush=True)
        b_status, b_headers, b_body, b_error = fetch(url)
        text = b_body.decode("utf-8", errors="replace")
        counts = {target: text.count(target) for target in TARGETS if target in text}
        for target, count in counts.items():
            aggregate_counts[target] += count

        evidence = {target: windows(text, target) for target in TARGETS if target in text}
        proximity = proximity_findings(text)
        proximity_total += len(proximity)

        if counts or proximity:
            report["bundles"].append(
                {
                    "url": url,
                    "status": b_status,
                    "error": b_error,
                    "bytes": len(b_body),
                    "content_type": b_headers.get("content-type"),
                    "counts": counts,
                    "evidence": evidence,
                    "source_sink_proximity": proximity,
                }
            )

    report["summary"] = {
        "bundles_discovered": len(urls),
        "bundles_with_relevant_hits": len(report["bundles"]),
        "aggregate_counts": {k: v for k, v in aggregate_counts.items() if v},
        "source_sink_proximity_findings": proximity_total,
        "limitations": [
            "Static proximity does not itself prove a data flow or browser execution.",
            "Authenticated-only chunks may not be present in the signed-out HTML shell.",
            "No credentials, cookies, POST requests, or user-controlled payloads were used.",
        ],
    }

    out = Path("xss_static_recon_report.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["root"], indent=2))
    print(json.dumps(report["summary"], indent=2))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

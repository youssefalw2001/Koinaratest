from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Any

BUNDLE_URL = "https://gmgn.ai/_next/static/chunks/8131-17c7a6182a9602eb.js"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MARKER = "TokenSocial.tsx"
RADIUS = 70_000

SOCIAL_TERMS = (
    "website",
    "website_url",
    "websiteUrl",
    "twitter",
    "twitter_url",
    "twitterUrl",
    "telegram",
    "telegram_url",
    "telegramUrl",
    "discord",
    "discord_url",
    "discordUrl",
    "social",
    "socials",
    "external_url",
    "externalUrl",
    "homepage",
)
VALIDATOR_TERMS = (
    "isSafeUrl",
    "safeUrl",
    "sanitizeUrl",
    "validateUrl",
    "normalizeUrl",
    "startsWith(\"http",
    "startsWith('http",
    "new URL(",
    "URL.canParse",
    "javascript:",
    "data:",
    "vbscript:",
)

SINK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("window_open", re.compile(r"window\.open\s*\(\s*(?P<expr>[^,\)\n]{1,1600})", re.I)),
    ("location_assign", re.compile(r"location\.assign\s*\(\s*(?P<expr>[^\)\n]{1,1600})", re.I)),
    ("location_replace", re.compile(r"location\.replace\s*\(\s*(?P<expr>[^\)\n]{1,1600})", re.I)),
    ("location_href", re.compile(r"location\.href\s*=\s*(?P<expr>[^;\n]{1,1600})", re.I)),
    ("href_prop", re.compile(r"\bhref\s*:\s*(?P<expr>[^,}\n]{1,1600})", re.I)),
    ("src_prop", re.compile(r"\bsrc\s*:\s*(?P<expr>[^,}\n]{1,1600})", re.I)),
)
IMPORT_RE = re.compile(
    r"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*"
    r"(?P<loader>[A-Za-z_$][A-Za-z0-9_$]*)\((?P<module>[0-9]{2,8})\)"
)
HELPER_RE = re.compile(
    r"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\."
    r"(?P<export>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(?P<arg>[^\)\n]{1,1600})\)"
)


def fetch_text() -> str:
    request = urllib.request.Request(
        BUNDLE_URL,
        headers={"User-Agent": UA, "Accept": "application/javascript,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read(30_000_000).decode("utf-8", errors="replace")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def marker_windows(bundle: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for match in re.finditer(re.escape(MARKER), bundle):
        low = max(0, match.start() - RADIUS)
        high = min(len(bundle), match.end() + RADIUS)
        body = bundle[low:high]
        output.append(
            {
                "marker_offset": match.start(),
                "start": low,
                "end": high,
                "bytes": len(body),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in body}),
                "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in body}),
                "body": body,
            }
        )
    return output


def sink_records(window: dict[str, Any]) -> list[dict[str, Any]]:
    body = window["body"]
    output: list[dict[str, Any]] = []
    for sink_name, pattern in SINK_PATTERNS:
        for match in pattern.finditer(body):
            low = max(0, match.start() - 6000)
            high = min(len(body), match.end() + 6000)
            context = compact(body[low:high])
            output.append(
                {
                    "sink": sink_name,
                    "offset_in_window": match.start(),
                    "absolute_offset": window["start"] + match.start(),
                    "expression": (match.groupdict().get("expr") or "").strip(),
                    "social_terms": sorted({term for term in SOCIAL_TERMS if term in context}),
                    "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in context}),
                    "context": context,
                }
            )
    return output


def helper_records(window: dict[str, Any]) -> list[dict[str, Any]]:
    body = window["body"]
    imports = {
        match.group("alias"): match.group("module")
        for match in IMPORT_RE.finditer(body)
    }
    output: list[dict[str, Any]] = []
    for match in HELPER_RE.finditer(body):
        low = max(0, match.start() - 4500)
        high = min(len(body), match.end() + 4500)
        context = compact(body[low:high])
        social_terms = sorted({term for term in SOCIAL_TERMS if term in context})
        if not social_terms:
            continue
        output.append(
            {
                "offset_in_window": match.start(),
                "absolute_offset": window["start"] + match.start(),
                "alias": match.group("alias"),
                "export": match.group("export"),
                "module_id": imports.get(match.group("alias")),
                "argument": match.group("arg").strip(),
                "social_terms": social_terms,
                "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in context}),
                "context": context,
            }
        )
    return output


def main() -> int:
    bundle = fetch_text()
    windows = marker_windows(bundle)
    if not windows:
        raise RuntimeError("TokenSocial.tsx marker not found")

    all_sinks: list[dict[str, Any]] = []
    all_helpers: list[dict[str, Any]] = []
    for window in windows:
        window["sinks"] = sink_records(window)
        window["helpers"] = helper_records(window)
        all_sinks.extend(window["sinks"])
        all_helpers.extend(window["helpers"])

    high_value_sinks = [
        sink
        for sink in all_sinks
        if any(
            term in sink["social_terms"]
            for term in ("website", "website_url", "websiteUrl", "twitter", "telegram", "discord", "socials")
        )
    ]
    report = {
        "bundle_url": BUNDLE_URL,
        "bundle_bytes": len(bundle),
        "marker": MARKER,
        "marker_count": len(windows),
        "windows": windows,
        "summary": {
            "sinks": len(all_sinks),
            "high_value_sinks": len(high_value_sinks),
            "helper_calls": len(all_helpers),
        },
        "high_value_sinks": high_value_sinks,
        "helper_calls": all_helpers,
    }
    out = Path("gmgn_tokensocial_extract.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    for index, window in enumerate(windows, start=1):
        print("WINDOW", index, window["marker_offset"], window["social_terms"], window["validator_terms"])
        print(compact(window["body"])[:9000])
    for sink in high_value_sinks:
        print(
            "SINK",
            json.dumps(
                {
                    "sink": sink["sink"],
                    "expression": sink["expression"][:1000],
                    "social_terms": sink["social_terms"],
                    "validator_terms": sink["validator_terms"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        print(sink["context"][:5000])
    for helper in all_helpers:
        print(
            "HELPER",
            json.dumps(
                {
                    "alias": helper["alias"],
                    "export": helper["export"],
                    "module_id": helper["module_id"],
                    "argument": helper["argument"][:1000],
                    "social_terms": helper["social_terms"],
                    "validator_terms": helper["validator_terms"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

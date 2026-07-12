from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Any

BUNDLE_URL = "https://gmgn.ai/_next/static/chunks/8131-17c7a6182a9602eb.js"
MODULE_ID = "598131"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

MODULE_START_RE = re.compile(
    r"(?:^|[,{}])(?P<id>[0-9]{2,8})\s*[:=]\s*"
    r"(?:(?:function\s*)?\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*"
    r"(?:=>)?\s*\{"
)
SOURCE_MARKER_RE = re.compile(
    r'(?:data-sentry-source-file:|["\']data-sentry-source-file["\']\s*:)["\']([^"\']+)["\']'
)
IMPORT_RE = re.compile(
    r"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*"
    r"(?P<loader>[A-Za-z_$][A-Za-z0-9_$]*)\((?P<module>[0-9]{2,8})\)"
)

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
    "link",
    "url",
)

SINK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("window_open", re.compile(r"window\.open\s*\(\s*(?P<expr>[^,\)\n]{1,1400})", re.I)),
    ("location_assign", re.compile(r"location\.assign\s*\(\s*(?P<expr>[^\)\n]{1,1400})", re.I)),
    ("location_replace", re.compile(r"location\.replace\s*\(\s*(?P<expr>[^\)\n]{1,1400})", re.I)),
    ("location_href", re.compile(r"location\.href\s*=\s*(?P<expr>[^;\n]{1,1400})", re.I)),
    ("href_prop", re.compile(r"\bhref\s*:\s*(?P<expr>[^,}\n]{1,1400})", re.I)),
    ("src_prop", re.compile(r"\bsrc\s*:\s*(?P<expr>[^,}\n]{1,1400})", re.I)),
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


def fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/javascript,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read(30_000_000).decode("utf-8", errors="replace")


def slice_module(bundle: str, module_id: str) -> tuple[int, int, str]:
    starts = list(MODULE_START_RE.finditer(bundle))
    target_index = next(
        (index for index, match in enumerate(starts) if match.group("id") == module_id),
        None,
    )
    if target_index is None:
        raise RuntimeError(f"module {module_id} not found")
    start = starts[target_index].start("id")
    end = starts[target_index + 1].start("id") if target_index + 1 < len(starts) else len(bundle)
    return start, end, bundle[start:end]


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def contexts(text: str, pattern: re.Pattern[str], radius: int = 7000) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for match in pattern.finditer(text):
        low = max(0, match.start() - radius)
        high = min(len(text), match.end() + radius)
        context = compact(text[low:high])
        output.append(
            {
                "offset": match.start(),
                "match": match.group(0),
                "expression": (match.groupdict().get("expr") or "").strip(),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in context}),
                "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in context}),
                "source_files": sorted(set(SOURCE_MARKER_RE.findall(context))),
                "context": context,
            }
        )
    return output


def source_sections(module: str) -> list[dict[str, Any]]:
    markers = list(SOURCE_MARKER_RE.finditer(module))
    output: list[dict[str, Any]] = []
    for index, marker in enumerate(markers):
        start = markers[index - 1].end() if index > 0 else 0
        end = markers[index + 1].start() if index + 1 < len(markers) else len(module)
        low = max(0, start - 3000)
        high = min(len(module), end + 12000)
        body = module[low:high]
        output.append(
            {
                "file": marker.group(1),
                "marker_offset": marker.start(),
                "start": low,
                "end": high,
                "bytes": len(body),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in body}),
                "validators": sorted({term for term in VALIDATOR_TERMS if term in body}),
                "body": body,
            }
        )
    return output


def helper_calls(text: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    pattern = re.compile(
        r"(?P<alias>[A-Za-z_$][A-Za-z0-9_$]*)\."
        r"(?P<export>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*(?P<arg>[^\)\n]{1,1200})\)"
    )
    imports = {
        match.group("alias"): match.group("module")
        for match in IMPORT_RE.finditer(text)
    }
    for match in pattern.finditer(text):
        low = max(0, match.start() - 3500)
        high = min(len(text), match.end() + 3500)
        context = compact(text[low:high])
        if not any(term in context for term in SOCIAL_TERMS):
            continue
        output.append(
            {
                "offset": match.start(),
                "alias": match.group("alias"),
                "export": match.group("export"),
                "module_id": imports.get(match.group("alias")),
                "argument": match.group("arg").strip(),
                "social_terms": sorted({term for term in SOCIAL_TERMS if term in context}),
                "validator_terms": sorted({term for term in VALIDATOR_TERMS if term in context}),
                "context": context,
            }
        )
    return output


def main() -> int:
    bundle = fetch_text(BUNDLE_URL)
    module_start, module_end, module = slice_module(bundle, MODULE_ID)
    imports = [
        {
            "alias": match.group("alias"),
            "loader": match.group("loader"),
            "module_id": match.group("module"),
        }
        for match in IMPORT_RE.finditer(module)
    ]
    sections = source_sections(module)
    token_social_sections = [
        section
        for section in sections
        if section["file"].lower() == "tokensocial.tsx"
        or "tokensocial" in section["file"].lower()
    ]

    sinks: list[dict[str, Any]] = []
    for sink_name, pattern in SINK_PATTERNS:
        for item in contexts(module, pattern):
            item["sink"] = sink_name
            sinks.append(item)

    token_social_sinks = [
        sink
        for sink in sinks
        if any("tokensocial" in file.lower() for file in sink["source_files"])
        or any(term in sink["social_terms"] for term in ("website", "twitter", "telegram", "discord", "socials"))
    ]

    report = {
        "bundle_url": BUNDLE_URL,
        "bundle_bytes": len(bundle),
        "module_id": MODULE_ID,
        "module_start": module_start,
        "module_end": module_end,
        "module_bytes": len(module),
        "source_files": sorted(set(SOURCE_MARKER_RE.findall(module))),
        "imports": imports,
        "token_social_sections": token_social_sections,
        "all_sinks": sinks,
        "token_social_sinks": token_social_sinks,
        "helper_calls": helper_calls(module),
        "module": module,
    }
    out = Path("gmgn_tokensocial_extract.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        json.dumps(
            {
                "bundle_bytes": len(bundle),
                "module_bytes": len(module),
                "source_files": len(report["source_files"]),
                "token_social_sections": len(token_social_sections),
                "all_sinks": len(sinks),
                "token_social_sinks": len(token_social_sinks),
                "helper_calls": len(report["helper_calls"]),
            },
            indent=2,
        )
    )
    for section in token_social_sections:
        print("SECTION", section["file"], section["social_terms"], section["validators"])
        print(compact(section["body"])[:9000])
    for sink in token_social_sinks:
        print(
            "SINK",
            json.dumps(
                {
                    "sink": sink["sink"],
                    "expression": sink["expression"][:1000],
                    "social_terms": sink["social_terms"],
                    "validator_terms": sink["validator_terms"],
                    "source_files": sink["source_files"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        print(sink["context"][:5000])
    for call in report["helper_calls"]:
        print(
            "HELPER",
            json.dumps(
                {
                    "alias": call["alias"],
                    "export": call["export"],
                    "module_id": call["module_id"],
                    "argument": call["argument"][:1000],
                    "social_terms": call["social_terms"],
                    "validator_terms": call["validator_terms"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

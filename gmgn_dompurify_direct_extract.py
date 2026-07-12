from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from pathlib import Path

URL = "https://gmgn.ai/_next/static/chunks/pages/_app-e377693a11a1c4c7.js"
MODULE_ID = "461617"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MODULE_RE = re.compile(
    r"(?:^|[,{}])(?P<id>[0-9]{2,8})\s*[:=]\s*"
    r"(?:(?:function\s*)?\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*"
    r"(?:=>)?\s*\{"
)


def fetch() -> str:
    request = urllib.request.Request(
        URL,
        headers={"User-Agent": UA, "Accept": "application/javascript,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read(30_000_000).decode("utf-8", errors="replace")


def main() -> int:
    text = fetch()
    starts = list(MODULE_RE.finditer(text))
    target_index = next(
        (index for index, match in enumerate(starts) if match.group("id") == MODULE_ID),
        None,
    )
    if target_index is None:
        raise SystemExit("module 461617 not found")

    start_match = starts[target_index]
    start = start_match.start("id")
    end = starts[target_index + 1].start("id") if target_index + 1 < len(starts) else len(text)
    body = text[start:end]

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
    assignments = sorted(
        set(
            match.group(0)
            for match in re.finditer(
                r"[A-Za-z_$][A-Za-z0-9_$]*\.version\s*=\s*[\"'][^\"']+[\"']",
                body,
                flags=re.I,
            )
        )
    )
    interesting_strings = sorted(
        {
            value
            for value in re.findall(r'[\"\']([^\"\']{1,240})[\"\']', body)
            if any(
                term in value.lower()
                for term in (
                    "version",
                    "dompurify",
                    "sanitize",
                    "trusted",
                    "svg",
                    "mathml",
                    "removed",
                    "isSupported",
                    "musu",
                )
            )
        }
    )

    markers = {
        "has_dompurify_factory": "DOMPurify" in body or "isSupported" in body,
        "has_sanitize_export": ".sanitize=" in body or "sanitize=function" in body,
        "has_removed_array": ".removed" in body,
        "has_html_component": "dangerouslySetInnerHTML" in body,
        "has_allowed_tags_config": "ALLOWED_TAGS" in body,
        "has_allow_unknown_protocols_false": "ALLOW_UNKNOWN_PROTOCOLS:!1" in body,
    }

    report = {
        "url": URL,
        "bundle_bytes": len(text),
        "webpack_modules_detected": len(starts),
        "module_id": MODULE_ID,
        "module_start": start,
        "module_end": end,
        "module_bytes": len(body),
        "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "semver_strings": semvers,
        "explicit_versions": explicit_versions,
        "version_assignments": assignments,
        "interesting_strings": interesting_strings,
        "markers": markers,
        "body": body,
    }
    out = Path("gmgn_dompurify_direct_module.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(
        json.dumps(
            {
                "bundle_bytes": len(text),
                "webpack_modules_detected": len(starts),
                "module_start": start,
                "module_end": end,
                "module_bytes": len(body),
                "sha256": report["sha256"],
                "semver_strings": semvers,
                "explicit_versions": explicit_versions,
                "version_assignments": assignments,
                "markers": markers,
            },
            indent=2,
        )
    )
    print("STRINGS", json.dumps(interesting_strings, ensure_ascii=False))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

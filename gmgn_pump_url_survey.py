from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

BASE = "https://gmgn.ai"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
CHAINS = ("sol", "bsc", "base", "eth")
LIST_LIMIT = 100
MAX_PREVIEWS = 160
DELAY = 0.12
ADDRESS_KEYS = (
    "address",
    "token_address",
    "tokenAddress",
    "contract_address",
    "contractAddress",
    "mint",
)


def fetch_json(path: str) -> tuple[int | None, Any, str | None]:
    url = path if path.startswith("http") else BASE + path
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Referer": BASE + "/",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read(8_000_000)
            return response.status, json.loads(raw.decode("utf-8", errors="replace")), None
    except urllib.error.HTTPError as exc:
        raw = exc.read(500_000)
        try:
            body = json.loads(raw.decode("utf-8", errors="replace"))
        except Exception:
            body = raw.decode("utf-8", errors="replace")[:1000]
        return exc.code, body, str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, None, f"{type(exc).__name__}: {exc}"


def walk_dicts(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_dicts(child)


def extract_address(item: dict[str, Any]) -> str | None:
    for key in ADDRESS_KEYS:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            candidate = value.strip()
            if re.fullmatch(r"0x[a-fA-F0-9]{40}", candidate) or re.fullmatch(
                r"[1-9A-HJ-NP-Za-km-z]{30,60}", candidate
            ):
                return candidate
    return None


def find_preview(value: Any) -> dict[str, Any] | None:
    for item in walk_dicts(value):
        if "detail_url_pump" in item or (
            "thumbnail" in item and "creator" in item and "name" in item
        ):
            return item
    return None


def normalize_address(value: str) -> str:
    return value.lower() if value.startswith("0x") else value


def url_analysis(url: str, address: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    decoded = urllib.parse.unquote(url)
    address_norm = normalize_address(address)
    path_norm = normalize_address(parsed.path)
    query_norm = normalize_address(parsed.query)
    return {
        "scheme": parsed.scheme.lower(),
        "host": (parsed.hostname or "").lower(),
        "port": parsed.port,
        "path": parsed.path,
        "query": parsed.query,
        "fragment": parsed.fragment,
        "username_present": parsed.username is not None,
        "password_present": parsed.password is not None,
        "address_in_path": address_norm in path_norm,
        "address_in_query": address_norm in query_norm,
        "raw_quote": '"' in url or "'" in url,
        "angle_bracket": "<" in url or ">" in url,
        "whitespace": any(char.isspace() for char in url),
        "control_character": any(ord(char) < 32 for char in url),
        "javascript_word": "javascript:" in decoded.lower(),
        "data_word": "data:" in decoded.lower(),
    }


def main() -> int:
    list_requests: list[dict[str, Any]] = []
    token_candidates: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for chain in CHAINS:
        path = (
            f"/api/v1/live/token_list/{chain}?"
            + urllib.parse.urlencode(
                {
                    "order_by": "time",
                    "direction": "desc",
                    "offset": 0,
                    "limit": LIST_LIMIT,
                }
            )
        )
        status, body, error = fetch_json(path)
        found = 0
        if body is not None:
            for item in walk_dicts(body):
                address = extract_address(item)
                if not address:
                    continue
                key = (chain, address)
                if key not in seen:
                    seen.add(key)
                    token_candidates.append(key)
                    found += 1
        list_requests.append(
            {
                "chain": chain,
                "path": path,
                "status": status,
                "error": error,
                "addresses_found": found,
            }
        )
        time.sleep(DELAY)

    previews: list[dict[str, Any]] = []
    request_records: list[dict[str, Any]] = []
    for chain, address in token_candidates[:MAX_PREVIEWS]:
        path = f"/api/v1/live/token_preview/{chain}/{urllib.parse.quote(address)}"
        status, body, error = fetch_json(path)
        preview = find_preview(body)
        url = preview.get("detail_url_pump") if preview else None
        record: dict[str, Any] = {
            "chain": chain,
            "address": address,
            "path": path,
            "status": status,
            "error": error,
            "preview_found": preview is not None,
            "url_present": isinstance(url, str) and bool(url),
        }
        if isinstance(url, str) and url:
            analysis = url_analysis(url, address)
            record["detail_url_pump"] = url
            record["analysis"] = analysis
            record["preview_keys"] = sorted(preview.keys())
            previews.append(record)
        request_records.append(record)
        print(
            "PREVIEW",
            json.dumps(
                {
                    "chain": chain,
                    "address": address,
                    "status": status,
                    "url": url,
                    "analysis": record.get("analysis"),
                    "error": error,
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
            flush=True,
        )
        time.sleep(DELAY)

    schemes = Counter(record["analysis"]["scheme"] for record in previews)
    hosts = Counter(record["analysis"]["host"] for record in previews)
    unsafe = [
        record
        for record in previews
        if record["analysis"]["scheme"] not in {"https", "http"}
        or record["analysis"]["host"] not in {"pump.fun", "www.pump.fun"}
        or record["analysis"]["raw_quote"]
        or record["analysis"]["angle_bracket"]
        or record["analysis"]["whitespace"]
        or record["analysis"]["control_character"]
        or record["analysis"]["javascript_word"]
        or record["analysis"]["data_word"]
    ]
    noncanonical = [
        record
        for record in previews
        if not (
            record["analysis"]["address_in_path"]
            or record["analysis"]["address_in_query"]
        )
    ]

    report = {
        "scope": "unauthenticated public live-list and token-preview GET requests only",
        "configuration": {
            "chains": CHAINS,
            "list_limit": LIST_LIMIT,
            "max_previews": MAX_PREVIEWS,
            "delay_seconds": DELAY,
        },
        "list_requests": list_requests,
        "summary": {
            "token_candidates": len(token_candidates),
            "preview_requests": len(request_records),
            "successful_preview_requests": sum(
                1 for record in request_records if record["status"] == 200
            ),
            "detail_urls": len(previews),
            "schemes": dict(schemes),
            "hosts": dict(hosts),
            "unsafe_urls": len(unsafe),
            "noncanonical_urls": len(noncanonical),
            "urls_with_address_in_path_or_query": sum(
                1
                for record in previews
                if record["analysis"]["address_in_path"]
                or record["analysis"]["address_in_query"]
            ),
        },
        "unsafe_urls": unsafe,
        "noncanonical_urls": noncanonical,
        "previews": previews,
        "requests": request_records,
    }
    out = Path("gmgn_pump_url_survey.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

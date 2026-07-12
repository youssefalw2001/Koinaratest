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
CHAIN_LIMITS = {"sol": 100, "bsc": 12, "base": 12, "eth": 12}
MAX_PAGES = 5
PAGE_LIMIT = 50
REQUEST_DELAY = 0.22
RANK_PATHS = (
    "/defi/quotation/v1/rank/{chain}/swaps/1h?orderby=swaps&direction=desc&limit=100",
    "/defi/quotation/v1/rank/{chain}/swaps/24h?orderby=swaps&direction=desc&limit=100",
    "/defi/quotation/v1/pairs/{chain}/new_pairs/24h?limit=100",
)
ADDRESS_KEYS = {
    "address",
    "token_address",
    "tokenAddress",
    "ca",
    "contract_address",
    "contractAddress",
    "pair_address",
}


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
            raw = response.read(7_000_000)
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


def collect_addresses(value: Any, out: list[str], seen: set[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ADDRESS_KEYS and isinstance(child, str):
                candidate = child.strip()
                if (
                    re.fullmatch(r"0x[a-fA-F0-9]{40}", candidate)
                    or re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{30,60}", candidate)
                ) and candidate not in seen:
                    seen.add(candidate)
                    out.append(candidate)
            collect_addresses(child, out, seen)
    elif isinstance(value, list):
        for child in value:
            collect_addresses(child, out, seen)


def find_page(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if isinstance(value.get("messages"), list):
            return value
        for child in value.values():
            found = find_page(child)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_page(child)
            if found is not None:
                return found
    return None


def shape(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "..."
    if isinstance(value, dict):
        return {key: shape(child, depth + 1) for key, child in list(value.items())[:30]}
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value else []
    return type(value).__name__


def main() -> int:
    tokens: dict[str, list[str]] = {chain: [] for chain in CHAIN_LIMITS}
    ranking_requests: list[dict[str, Any]] = []

    for chain, chain_limit in CHAIN_LIMITS.items():
        seen: set[str] = set()
        for template in RANK_PATHS:
            if len(tokens[chain]) >= chain_limit:
                break
            path = template.format(chain=chain)
            status, body, error = fetch_json(path)
            before = len(tokens[chain])
            if body is not None:
                collect_addresses(body, tokens[chain], seen)
            tokens[chain] = tokens[chain][:chain_limit]
            ranking_requests.append(
                {
                    "chain": chain,
                    "path": path,
                    "status": status,
                    "error": error,
                    "new_addresses": max(0, len(tokens[chain]) - before),
                }
            )
            time.sleep(REQUEST_DELAY)

    requests: list[dict[str, Any]] = []
    media_records: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    first_response_shape: Any = None
    stop_reason = "completed"

    for chain, chain_tokens in tokens.items():
        for token in chain_tokens:
            cursor: str | None = None
            for page_number in range(1, MAX_PAGES + 1):
                params: dict[str, Any] = {"limit": PAGE_LIMIT}
                if cursor:
                    params["cursor"] = cursor
                path = (
                    f"/api/v1/token/{chain}/{urllib.parse.quote(token)}/community/messages?"
                    + urllib.parse.urlencode(params)
                )
                status, body, error = fetch_json(path)
                if first_response_shape is None and body is not None:
                    first_response_shape = shape(body)
                page = find_page(body)
                messages = (
                    [message for message in page.get("messages", []) if isinstance(message, dict)]
                    if page
                    else []
                )
                for message in messages:
                    source_counts[str(message.get("source") or "")] += 1
                    media = message.get("media_url")
                    if isinstance(media, str) and media:
                        media_records.append(
                            {
                                "chain": chain,
                                "token": token,
                                "page": page_number,
                                "source": message.get("source"),
                                "id": message.get("id"),
                                "ulid": message.get("ulid"),
                                "media_url": media,
                                "contains_quote": '"' in media or "'" in media,
                                "contains_angle": "<" in media or ">" in media,
                                "contains_whitespace": any(char.isspace() for char in media),
                                "message_keys": sorted(message.keys()),
                            }
                        )
                has_more = bool(page.get("has_more")) if page else False
                next_cursor = page.get("next_cursor") if page else None
                requests.append(
                    {
                        "chain": chain,
                        "token": token,
                        "page": page_number,
                        "status": status,
                        "error": error,
                        "messages": len(messages),
                        "media": sum(
                            1
                            for message in messages
                            if isinstance(message.get("media_url"), str)
                            and message.get("media_url")
                        ),
                        "has_more": has_more,
                        "next_cursor_present": bool(next_cursor),
                    }
                )
                print(
                    "PAGE",
                    json.dumps(
                        requests[-1],
                        sort_keys=True,
                    ),
                    flush=True,
                )
                if media_records:
                    stop_reason = "non_null_media_found"
                    break
                if status != 200 or not page or not has_more or not next_cursor:
                    break
                cursor = str(next_cursor)
                time.sleep(REQUEST_DELAY)
            if media_records:
                break
            time.sleep(REQUEST_DELAY)
        if media_records:
            break

    report = {
        "scope": "unauthenticated public rank and community-message reads only",
        "configuration": {
            "chain_limits": CHAIN_LIMITS,
            "max_pages": MAX_PAGES,
            "page_limit": PAGE_LIMIT,
            "delay_seconds": REQUEST_DELAY,
        },
        "tokens_discovered": {chain: len(values) for chain, values in tokens.items()},
        "ranking_requests": ranking_requests,
        "summary": {
            "stop_reason": stop_reason,
            "community_requests": len(requests),
            "successful_requests": sum(1 for request in requests if request["status"] == 200),
            "messages": sum(request["messages"] for request in requests),
            "media_records": len(media_records),
            "sources": dict(source_counts),
            "pages_with_more": sum(1 for request in requests if request["has_more"]),
            "pages_with_cursor": sum(1 for request in requests if request["next_cursor_present"]),
        },
        "first_response_shape": first_response_shape,
        "media_records": media_records,
        "community_requests": requests,
    }
    out = Path("gmgn_historical_media_survey.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    for record in media_records:
        print("MEDIA", json.dumps(record, ensure_ascii=False, sort_keys=True))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

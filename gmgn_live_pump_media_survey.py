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
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
CHAIN = "sol"
LIST_OFFSETS = (0, 100, 200)
LIST_LIMIT = 100
MAX_TOKENS = 220
MAX_PAGES = 6
PAGE_LIMIT = 50
DELAY = 0.16
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
            body = raw.decode("utf-8", errors="replace")[:1200]
        return exc.code, body, str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, None, f"{type(exc).__name__}: {exc}"


def walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def address_from(item: dict[str, Any]) -> str | None:
    for key in ADDRESS_KEYS:
        value = item.get(key)
        if not isinstance(value, str):
            continue
        candidate = value.strip()
        if re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{30,60}", candidate):
            return candidate
    return None


def find_page(value: Any) -> dict[str, Any] | None:
    for item in walk(value):
        if isinstance(item.get("messages"), list):
            return item
    return None


def shape(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "..."
    if isinstance(value, dict):
        return {key: shape(child, depth + 1) for key, child in list(value.items())[:35]}
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value else []
    return type(value).__name__


def analyze_media(url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlparse(url)
    decoded = urllib.parse.unquote(url)
    return {
        "scheme": parsed.scheme.lower(),
        "host": (parsed.hostname or "").lower(),
        "raw_quote": '"' in url or "'" in url,
        "angle_bracket": "<" in url or ">" in url,
        "whitespace": any(char.isspace() for char in url),
        "control_character": any(ord(char) < 32 for char in url),
        "javascript_word": "javascript:" in decoded.lower(),
        "data_word": "data:" in decoded.lower(),
        "length": len(url),
    }


def main() -> int:
    list_requests: list[dict[str, Any]] = []
    tokens: list[str] = []
    seen: set[str] = set()

    for offset in LIST_OFFSETS:
        path = (
            f"/api/v1/live/token_list/{CHAIN}?"
            + urllib.parse.urlencode(
                {
                    "order_by": "time",
                    "direction": "desc",
                    "offset": offset,
                    "limit": LIST_LIMIT,
                }
            )
        )
        status, body, error = fetch_json(path)
        before = len(tokens)
        if body is not None:
            for item in walk(body):
                address = address_from(item)
                if address and address not in seen:
                    seen.add(address)
                    tokens.append(address)
        list_requests.append(
            {
                "path": path,
                "status": status,
                "error": error,
                "new_addresses": len(tokens) - before,
            }
        )
        time.sleep(DELAY)

    tokens = tokens[:MAX_TOKENS]
    request_records: list[dict[str, Any]] = []
    media_records: list[dict[str, Any]] = []
    source_counts: Counter[str] = Counter()
    first_shape: Any = None

    for token_index, token in enumerate(tokens, start=1):
        cursor: str | None = None
        for page_number in range(1, MAX_PAGES + 1):
            params: dict[str, Any] = {"limit": PAGE_LIMIT}
            if cursor:
                params["cursor"] = cursor
            path = (
                f"/api/v1/token/{CHAIN}/{urllib.parse.quote(token)}/community/messages?"
                + urllib.parse.urlencode(params)
            )
            status, body, error = fetch_json(path)
            if first_shape is None and body is not None:
                first_shape = shape(body)
            page = find_page(body)
            messages = (
                [message for message in page.get("messages", []) if isinstance(message, dict)]
                if page
                else []
            )

            page_media = 0
            for message in messages:
                source = str(message.get("source") or "")
                source_counts[source] += 1
                media = message.get("media_url")
                if isinstance(media, str) and media:
                    page_media += 1
                    media_records.append(
                        {
                            "token_index": token_index,
                            "token": token,
                            "page": page_number,
                            "source": source,
                            "id": message.get("id"),
                            "ulid": message.get("ulid"),
                            "media_url": media,
                            "media_analysis": analyze_media(media),
                            "message_keys": sorted(message.keys()),
                            "source_content_type": type(message.get("source_content")).__name__,
                        }
                    )

            has_more = bool(page.get("has_more")) if page else False
            next_cursor = page.get("next_cursor") if page else None
            record = {
                "token_index": token_index,
                "token": token,
                "page": page_number,
                "path": path,
                "status": status,
                "error": error,
                "messages": len(messages),
                "media": page_media,
                "has_more": has_more,
                "next_cursor_present": bool(next_cursor),
                "sources": dict(Counter(str(message.get("source") or "") for message in messages)),
            }
            request_records.append(record)
            print("PAGE", json.dumps(record, sort_keys=True), flush=True)

            if media_records:
                break
            if status != 200 or not page or not has_more or not next_cursor:
                break
            cursor = str(next_cursor)
            time.sleep(DELAY)
        if media_records:
            break
        time.sleep(DELAY)

    unsafe_media = [
        record
        for record in media_records
        if record["media_analysis"]["scheme"] not in {"http", "https"}
        or record["media_analysis"]["raw_quote"]
        or record["media_analysis"]["angle_bracket"]
        or record["media_analysis"]["whitespace"]
        or record["media_analysis"]["control_character"]
        or record["media_analysis"]["javascript_word"]
        or record["media_analysis"]["data_word"]
    ]

    report = {
        "scope": "unauthenticated public live-token and community-message GET requests only",
        "configuration": {
            "chain": CHAIN,
            "list_offsets": LIST_OFFSETS,
            "list_limit": LIST_LIMIT,
            "max_tokens": MAX_TOKENS,
            "max_pages": MAX_PAGES,
            "page_limit": PAGE_LIMIT,
            "delay_seconds": DELAY,
        },
        "list_requests": list_requests,
        "summary": {
            "live_tokens": len(tokens),
            "community_requests": len(request_records),
            "successful_requests": sum(1 for record in request_records if record["status"] == 200),
            "messages": sum(record["messages"] for record in request_records),
            "sources": dict(source_counts),
            "pump_messages": source_counts.get("pump", 0),
            "media_records": len(media_records),
            "unsafe_media_records": len(unsafe_media),
            "pages_with_more": sum(1 for record in request_records if record["has_more"]),
        },
        "first_response_shape": first_shape,
        "media_records": media_records,
        "unsafe_media_records": unsafe_media,
        "requests": request_records,
    }
    out = Path("gmgn_live_pump_media_survey.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    for record in media_records:
        print("MEDIA", json.dumps(record, ensure_ascii=False, sort_keys=True))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

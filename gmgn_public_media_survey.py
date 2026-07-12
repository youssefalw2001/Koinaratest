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
RANK_PATHS = (
    "/defi/quotation/v1/rank/{chain}/swaps/1h?orderby=swaps&direction=desc&limit=30",
    "/defi/quotation/v1/rank/{chain}/swaps/24h?orderby=swaps&direction=desc&limit=30",
    "/defi/quotation/v1/pairs/{chain}/new_pairs/24h?limit=30",
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


def fetch_json(path_or_url: str) -> tuple[int | None, Any, str | None]:
    url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
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
            raw = response.read(5_000_000)
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


def collect_addresses(value: Any, out: set[str]) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ADDRESS_KEYS and isinstance(child, str):
                candidate = child.strip()
                if re.fullmatch(r"0x[a-fA-F0-9]{40}", candidate) or re.fullmatch(
                    r"[1-9A-HJ-NP-Za-km-z]{30,60}", candidate
                ):
                    out.add(candidate)
            collect_addresses(child, out)
    elif isinstance(value, list):
        for child in value:
            collect_addresses(child, out)


def find_message_lists(value: Any) -> list[list[dict[str, Any]]]:
    found: list[list[dict[str, Any]]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "messages" and isinstance(child, list):
                found.append([item for item in child if isinstance(item, dict)])
            found.extend(find_message_lists(child))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_message_lists(child))
    return found


def host_of(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""


def main() -> int:
    ranking: list[dict[str, Any]] = []
    tokens: dict[str, set[str]] = {chain: set() for chain in CHAINS}
    for chain in CHAINS:
        for template in RANK_PATHS:
            path = template.format(chain=chain)
            status, body, error = fetch_json(path)
            found: set[str] = set()
            if body is not None:
                collect_addresses(body, found)
                tokens[chain].update(found)
            ranking.append(
                {
                    "chain": chain,
                    "path": path,
                    "status": status,
                    "error": error,
                    "addresses_found": len(found),
                }
            )
            time.sleep(0.15)

    requests: list[dict[str, Any]] = []
    media_records: list[dict[str, Any]] = []
    all_sources: Counter[str] = Counter()
    all_keys: Counter[str] = Counter()

    for chain in CHAINS:
        for token in list(tokens[chain])[:25]:
            path = f"/api/v1/token/{chain}/{urllib.parse.quote(token)}/community/messages?limit=50"
            status, body, error = fetch_json(path)
            lists = find_message_lists(body)
            messages = [message for group in lists for message in group]
            for message in messages:
                all_keys.update(message.keys())
                all_sources[str(message.get("source") or "")] += 1
                media = message.get("media_url")
                if isinstance(media, str) and media:
                    media_records.append(
                        {
                            "chain": chain,
                            "token": token,
                            "source": message.get("source"),
                            "id": message.get("id"),
                            "ulid": message.get("ulid"),
                            "media_url": media,
                            "media_host": host_of(media),
                            "contains_quote": '"' in media or "'" in media,
                            "contains_angle": "<" in media or ">" in media,
                            "contains_space": any(char.isspace() for char in media),
                            "extension": urllib.parse.urlparse(media).path.rsplit(".", 1)[-1].lower()
                            if "." in urllib.parse.urlparse(media).path
                            else "",
                            "message_keys": sorted(message.keys()),
                        }
                    )
            requests.append(
                {
                    "chain": chain,
                    "token": token,
                    "path": path,
                    "status": status,
                    "error": error,
                    "message_count": len(messages),
                    "media_count": sum(
                        1
                        for message in messages
                        if isinstance(message.get("media_url"), str) and message.get("media_url")
                    ),
                }
            )
            time.sleep(0.12)

    report = {
        "scope": "unauthenticated public ranking and community-message reads only",
        "ranking": ranking,
        "tokens_discovered": {chain: len(values) for chain, values in tokens.items()},
        "community_requests": requests,
        "summary": {
            "requests": len(requests),
            "successful_requests": sum(1 for request in requests if request["status"] == 200),
            "messages": sum(request["message_count"] for request in requests),
            "media_records": len(media_records),
            "sources": dict(all_sources),
            "media_hosts": dict(Counter(record["media_host"] for record in media_records)),
            "media_extensions": dict(Counter(record["extension"] for record in media_records)),
            "media_with_raw_quote": sum(1 for record in media_records if record["contains_quote"]),
            "media_with_angle_bracket": sum(1 for record in media_records if record["contains_angle"]),
            "message_keys": dict(all_keys),
        },
        "media_records": media_records[:500],
    }
    out = Path("gmgn_public_media_survey.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    for record in media_records[:100]:
        print("MEDIA", json.dumps(record, ensure_ascii=False, sort_keys=True))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

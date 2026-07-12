from __future__ import annotations

import concurrent.futures
import json
import time
import uuid
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed

VERSION = "20260711-1981-88dbe3a"
ENDPOINTS = ("wss://ws.gmgn.ai/ws", "wss://ws.gmgn.ai/v2/ws")
CHAINS = ("sol", "bsc")
DURATION_SECONDS = 105
UNSAFE_SCHEMES = {"javascript", "data", "vbscript", "file"}


def connection_url(endpoint: str) -> str:
    session_id = str(uuid.uuid4())
    params = {
        "device_id": str(uuid.uuid4()),
        "fp_did": "unknown",
        "client_id": f"gmgn_web_{VERSION}",
        "from_app": "gmgn",
        "app_ver": VERSION,
        "tz_name": "UTC",
        "tz_offset": "0",
        "app_lang": "en-US",
        "os": "web",
        "worker": "0",
        "uuid": session_id,
        "reconnect": "0",
    }
    return f"{endpoint}?{urlencode(params)}"


def iter_dicts(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_dicts(child)


def classify_url(raw: object) -> dict | None:
    if not isinstance(raw, str):
        return None
    stripped = raw.strip()
    parsed = urlsplit(stripped)
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    return {
        "scheme": scheme or "<missing>",
        "host": hostname or "<missing>",
        "length_bucket": (
            "0-63" if len(raw) < 64 else "64-127" if len(raw) < 128 else "128+"
        ),
        "has_control_chars": any(ord(char) < 32 or ord(char) == 127 for char in raw),
        "has_quotes": '"' in raw or "'" in raw,
        "unsafe_scheme": scheme in UNSAFE_SCHEMES,
        "non_http_scheme": bool(scheme) and scheme not in {"http", "https"},
        "leading_or_trailing_space": raw != stripped,
    }


def sample(endpoint: str) -> dict:
    result = {
        "endpoint": endpoint,
        "connected": False,
        "error": None,
        "frames": 0,
        "json_frames": 0,
        "public_broadcast_frames": 0,
        "event_types": Counter(),
        "url_classes": Counter(),
        "unsafe_scheme_count": 0,
        "non_http_scheme_count": 0,
        "missing_scheme_count": 0,
        "url_count": 0,
    }
    deadline = time.monotonic() + DURATION_SECONDS
    try:
        with connect(
            connection_url(endpoint),
            origin="https://gmgn.ai",
            open_timeout=20,
            close_timeout=5,
            max_size=4_000_000,
        ) as websocket:
            result["connected"] = True
            subscription = {
                "action": "subscribe",
                "channel": "public_broadcast",
                "f": "w",
                "id": str(uuid.uuid4()),
                "data": [{"chain": chain} for chain in CHAINS],
            }
            websocket.send(json.dumps(subscription, separators=(",", ":")))

            while time.monotonic() < deadline:
                try:
                    message = websocket.recv(timeout=5)
                except TimeoutError:
                    continue
                except ConnectionClosed as exc:
                    result["error"] = f"ConnectionClosed:{exc.code}:{exc.reason}"
                    break
                result["frames"] += 1
                if isinstance(message, bytes):
                    try:
                        message = message.decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                try:
                    payload = json.loads(message)
                except Exception:
                    continue
                result["json_frames"] += 1
                if isinstance(payload, dict) and payload.get("channel") == "public_broadcast":
                    result["public_broadcast_frames"] += 1

                for obj in iter_dicts(payload):
                    event_type = obj.get("et")
                    if isinstance(event_type, str):
                        result["event_types"][event_type] += 1
                    if "cu" not in obj:
                        continue
                    classification = classify_url(obj.get("cu"))
                    if classification is None:
                        continue
                    result["url_count"] += 1
                    key = (
                        classification["scheme"],
                        classification["host"],
                        classification["length_bucket"],
                        classification["has_control_chars"],
                        classification["has_quotes"],
                        classification["leading_or_trailing_space"],
                    )
                    result["url_classes"][key] += 1
                    result["unsafe_scheme_count"] += int(classification["unsafe_scheme"])
                    result["non_http_scheme_count"] += int(classification["non_http_scheme"])
                    result["missing_scheme_count"] += int(classification["scheme"] == "<missing>")
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"

    result["event_types"] = dict(result["event_types"])
    result["url_classes"] = [
        {
            "scheme": key[0],
            "host": key[1],
            "length_bucket": key[2],
            "has_control_chars": key[3],
            "has_quotes": key[4],
            "leading_or_trailing_space": key[5],
            "count": count,
        }
        for key, count in sorted(result["url_classes"].items())
    ]
    return result


def main() -> int:
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ENDPOINTS)) as pool:
        results = list(pool.map(sample, ENDPOINTS))

    summary = {
        "generated_at": int(time.time()),
        "scope": "Unauthenticated public WebSocket sampling. No raw URLs or personal content retained.",
        "duration_seconds_per_endpoint": DURATION_SECONDS,
        "chains": list(CHAINS),
        "connected_endpoints": sum(bool(item["connected"]) for item in results),
        "frames": sum(item["frames"] for item in results),
        "public_broadcast_frames": sum(item["public_broadcast_frames"] for item in results),
        "url_count": sum(item["url_count"] for item in results),
        "unsafe_scheme_count": sum(item["unsafe_scheme_count"] for item in results),
        "non_http_scheme_count": sum(item["non_http_scheme_count"] for item in results),
        "missing_scheme_count": sum(item["missing_scheme_count"] for item in results),
        "results": results,
    }
    Path("gmgn_public_broadcast_sample.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

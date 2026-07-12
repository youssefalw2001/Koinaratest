from __future__ import annotations

import json
import shutil
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

PAGES = (
    "https://gmgn.ai/?chain=sol",
    "https://gmgn.ai/?chain=bsc",
    "https://gmgn.ai/trenches?chain=sol",
)
SECONDS_PER_PAGE = 38
UNSAFE_SCHEMES = {"javascript", "data", "vbscript", "file"}


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


def main() -> int:
    result = {
        "generated_at": int(time.time()),
        "scope": "Unauthenticated browser WebSocket observation. No raw URLs, messages, usernames, wallets, or personal content retained.",
        "pages": [],
        "browser_launched": False,
        "websocket_connections": Counter(),
        "handshake_statuses": Counter(),
        "frames": 0,
        "json_frames": 0,
        "public_broadcast_frames": 0,
        "event_types": Counter(),
        "url_classes": Counter(),
        "url_count": 0,
        "unsafe_scheme_count": 0,
        "non_http_scheme_count": 0,
        "missing_scheme_count": 0,
        "errors": [],
    }

    chrome = next(
        (
            shutil.which(name)
            for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
            if shutil.which(name)
        ),
        None,
    )

    with sync_playwright() as playwright:
        launch_args = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--no-first-run",
            ],
        }
        if chrome:
            launch_args["executable_path"] = chrome
        browser = playwright.chromium.launch(**launch_args)
        result["browser_launched"] = True
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="UTC",
            viewport={"width": 1440, "height": 1000},
        )
        page = context.new_page()
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")

        def on_created(event):
            raw = event.get("url")
            if not isinstance(raw, str):
                return
            parsed = urlsplit(raw)
            result["websocket_connections"][(parsed.scheme, parsed.hostname or "", parsed.path)] += 1

        def on_handshake(event):
            status = event.get("response", {}).get("status")
            result["handshake_statuses"][str(status)] += 1

        def on_frame(event):
            response = event.get("response", {})
            if response.get("opcode") != 1:
                return
            payload_data = response.get("payloadData")
            if not isinstance(payload_data, str):
                return
            result["frames"] += 1
            try:
                payload = json.loads(payload_data)
            except Exception:
                return
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

        cdp.on("Network.webSocketCreated", on_created)
        cdp.on("Network.webSocketHandshakeResponseReceived", on_handshake)
        cdp.on("Network.webSocketFrameReceived", on_frame)

        for url in PAGES:
            item = {"url_path": urlsplit(url).path or "/", "status": None, "error": None}
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
                item["status"] = response.status if response else None
                page.wait_for_timeout(SECONDS_PER_PAGE * 1000)
            except Exception as exc:  # noqa: BLE001
                item["error"] = f"{type(exc).__name__}: {exc}"
            result["pages"].append(item)

        context.close()
        browser.close()

    result["websocket_connections"] = [
        {"scheme": key[0], "host": key[1], "path": key[2], "count": count}
        for key, count in sorted(result["websocket_connections"].items())
    ]
    result["handshake_statuses"] = dict(result["handshake_statuses"])
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

    Path("gmgn_browser_broadcast_sample.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

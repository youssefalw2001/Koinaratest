from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

URL = "https://gmgn.ai/_next/static/chunks/9601-8093e58520d052b8.js"
MODULE_IDS = ("542550", "704108", "170051", "593862", "458505")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/javascript,*/*"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read(20_000_000).decode("utf-8", errors="replace")


def matching_brace(text: str, open_index: int) -> int | None:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    index = open_index
    while index < len(text):
        char = text[index]
        nxt = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if char == "*" and nxt == "/":
                block_comment = False
                index += 2
                continue
            index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            index += 1
            continue
        if char == "/" and nxt == "/":
            line_comment = True
            index += 2
            continue
        if char == "/" and nxt == "*":
            block_comment = True
            index += 2
            continue
        if char in {"'", '"', "`"}:
            quote = char
            index += 1
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def extract_module(text: str, module_id: str) -> dict:
    pattern = re.compile(
        rf"(?:(?<=\{{)|(?<=,)){module_id}:(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{"
    )
    match = pattern.search(text)
    if not match:
        return {"module_id": module_id, "error": "not found"}
    open_index = match.end() - 1
    close_index = matching_brace(text, open_index)
    if close_index is None:
        return {"module_id": module_id, "error": "closing brace not found"}
    body = text[open_index + 1 : close_index]
    strings = sorted(
        {
            value
            for value in re.findall(r'["\']([^"\']{1,180})["\']', body)
            if any(
                term in value.lower()
                for term in (
                    "/api",
                    "/tapi",
                    "/xapi",
                    "community",
                    "callout",
                    "media",
                    "upload",
                    "twitter",
                    "message",
                )
            )
        }
    )
    return {
        "module_id": module_id,
        "start": match.start(),
        "end": close_index + 1,
        "module_bytes": len(body),
        "interesting_strings": strings,
        "body": body,
    }


def main() -> int:
    text = fetch(URL)
    modules = [extract_module(text, module_id) for module_id in MODULE_IDS]
    activity = next((module for module in modules if module.get("module_id") == "542550"), {})
    body = activity.get("body", "")
    aliases = re.findall(r"([A-Za-z_$][A-Za-z0-9_$]*)=l\(688884\)", body)
    alias_hits = {}
    for alias in aliases:
        positions = [m.start() for m in re.finditer(re.escape(alias) + r"\.A", body)]
        alias_hits[alias] = [
            {
                "offset": position,
                "context": body[max(0, position - 5000) : min(len(body), position + 8000)],
            }
            for position in positions
        ]
    report = {
        "url": URL,
        "modules": modules,
        "autopause_aliases": aliases,
        "autopause_alias_hits": alias_hits,
    }
    out = Path("gmgn_community_media_modules.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for module in modules:
        print("MODULE", module.get("module_id"), "BYTES", module.get("module_bytes"), "ERROR", module.get("error"))
        print("STRINGS", json.dumps(module.get("interesting_strings", []), ensure_ascii=False))
    print("AUTOPAUSE_ALIASES", aliases)
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

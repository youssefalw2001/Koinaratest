from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

URL = "https://gmgn.ai/_next/static/chunks/9601-8093e58520d052b8.js"
MODULE_ID = "542550"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/javascript,*/*"})
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


def main() -> int:
    text = fetch(URL)
    pattern = re.compile(
        rf"(?:(?<=\{{)|(?<=,)){MODULE_ID}:(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{"
    )
    match = pattern.search(text)
    if not match:
        raise SystemExit("module not found")
    open_index = match.end() - 1
    close_index = matching_brace(text, open_index)
    if close_index is None:
        raise SystemExit("module brace not found")
    body = text[open_index + 1 : close_index]
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
        "module_id": MODULE_ID,
        "module_bytes": len(body),
        "aliases": aliases,
        "alias_hits": alias_hits,
        "body": body,
    }
    out = Path("gmgn_activity_module_542550.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print("MODULE_BYTES", len(body))
    print("ALIASES", aliases)
    for alias, hits in alias_hits.items():
        print("ALIAS_HITS", alias, len(hits))
        for hit in hits:
            print(hit["context"][:6000])
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

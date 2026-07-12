from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

TARGETS = {
    "https://gmgn.ai/_next/static/chunks/pages/_app-e377693a11a1c4c7.js": [
        "688884",
        "484811",
        "752157",
        "924282",
    ],
    "https://gmgn.ai/_next/static/chunks/7171-1c6b910cf6da5557.js": [
        "506584",
        "372547",
    ],
}

SEARCH_TERMS = (
    "AutoPauseVideo",
    "srcDoc",
    "dangerouslySetInnerHTML",
    "createContextualFragment",
    "insertAdjacentHTML",
    "formatter:",
    "tooltip",
    "iconUrl",
    "videoUrl",
    "video_url",
    "embedHtml",
    "embed_html",
)


def fetch(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/javascript,*/*;q=0.8"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        return response.read(20_000_000).decode("utf-8", errors="replace")


def find_matching_brace(text: str, open_index: int) -> int | None:
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


def extract_module(text: str, module_id: str) -> dict[str, Any] | None:
    pattern = re.compile(
        rf"(?:(?<=\{{)|(?<=,)){re.escape(module_id)}:(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{{"
    )
    match = pattern.search(text)
    if not match:
        return None
    open_index = match.end() - 1
    close_index = find_matching_brace(text, open_index)
    if close_index is None:
        return None
    prefix = text[match.start() : open_index + 1]
    body = text[open_index + 1 : close_index]
    return {
        "module_id": module_id,
        "start": match.start(),
        "end": close_index + 1,
        "prefix": prefix,
        "bytes": len(body),
        "body": body,
    }


def contexts(text: str, term: str, radius: int = 4500, limit: int = 20) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    start = 0
    while len(found) < limit:
        index = text.find(term, start)
        if index < 0:
            break
        lo = max(0, index - radius)
        hi = min(len(text), index + len(term) + radius)
        found.append(
            {
                "offset": index,
                "context": re.sub(r"\s+", " ", text[lo:hi]),
            }
        )
        start = index + len(term)
    return found


def main() -> int:
    report: dict[str, Any] = {"targets": [], "search_hits": []}
    for url, module_ids in TARGETS.items():
        try:
            text = fetch(url)
        except Exception as exc:  # noqa: BLE001
            report["targets"].append({"url": url, "error": f"{type(exc).__name__}: {exc}"})
            continue

        record: dict[str, Any] = {"url": url, "bytes": len(text), "modules": []}
        for module_id in module_ids:
            module = extract_module(text, module_id)
            record["modules"].append(module or {"module_id": module_id, "error": "not found"})
        report["targets"].append(record)

        for term in SEARCH_TERMS:
            hit_contexts = contexts(text, term)
            if hit_contexts:
                report["search_hits"].append(
                    {
                        "url": url,
                        "term": term,
                        "count": text.count(term),
                        "contexts": hit_contexts,
                    }
                )

    out = Path("gmgn_targeted_xss_extract.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    for target in report["targets"]:
        print("TARGET", target.get("url"), "bytes", target.get("bytes"), "error", target.get("error"))
        for module in target.get("modules", []):
            print("MODULE", module.get("module_id"), "bytes", module.get("bytes"), "error", module.get("error"))
    for hit in report["search_hits"]:
        print("HIT", hit["term"], hit["count"], hit["url"])
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

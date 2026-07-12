from __future__ import annotations

import concurrent.futures
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

BASE = "https://gmgn.ai"
ROUTES = (
    "/",
    "/login",
    "/tglogin",
    "/trade",
    "/trenches",
    "/discover",
    "/portfolio",
    "/watchlist",
    "/rewards",
    "/profile",
    "/settings",
    "/invite",
    "/referral",
    "/sol",
    "/bsc",
    "/base",
    "/eth",
)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_SCRIPTS = 380
MAX_BYTES = 24_000_000
WORKERS = 16
MODULE_START_RE = re.compile(
    r"(?:(?<=\{)|(?<=,))(?P<id>\d+):(?:function\([^)]*\)|\([^)]*\)=>|[A-Za-z_$][A-Za-z0-9_$]*=>)\{"
)

RECEIVER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "addEventListener_message",
        re.compile(
            r"(?:window\.|self\.|globalThis\.)?addEventListener\s*\(\s*[\"']message[\"']",
            re.I,
        ),
    ),
    (
        "onmessage_assignment",
        re.compile(r"(?:window\.|self\.|globalThis\.)?onmessage\s*=", re.I),
    ),
    (
        "message_port_receiver",
        re.compile(r"\.(?:port1|port2|contentWindow)\.onmessage\s*=|MessageChannel\s*\(", re.I),
    ),
)

ORIGIN_CHECK_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("event_origin", re.compile(r"\b(?:event|evt|messageEvent|e|t|n)\.origin\b", re.I)),
    ("source_check", re.compile(r"\b(?:event|evt|messageEvent|e|t|n)\.source\b", re.I)),
    ("location_origin", re.compile(r"(?:window\.)?location\.origin", re.I)),
    ("allowed_origins", re.compile(r"allowedOrigins?|trustedOrigins?|validOrigins?|originAllow", re.I)),
    ("origin_equality", re.compile(r"\.origin\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\s*[^;]{0,150}\.origin", re.I)),
    ("origin_collection", re.compile(r"\.includes\s*\([^)]*\.origin|\.has\s*\([^)]*\.origin", re.I)),
)

DATA_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("event_data", re.compile(r"\b(?:event|evt|messageEvent|e|t|n)\.data\b", re.I)),
    ("destructured_data", re.compile(r"\{\s*data\s*\}\s*=|\(\s*\{\s*data\s*\}\s*\)\s*=>", re.I)),
    ("json_parse", re.compile(r"JSON\.parse\s*\(", re.I)),
)

DANGEROUS_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("innerHTML", re.compile(r"\.innerHTML\s*=|dangerouslySetInnerHTML|insertAdjacentHTML|srcDoc\s*[:=]", re.I)),
    ("document_write", re.compile(r"document\.write(?:ln)?\s*\(", re.I)),
    ("eval", re.compile(r"(?<![A-Za-z0-9_$])eval\s*\(|new\s+Function\s*\(", re.I)),
    ("navigation", re.compile(r"window\.open\s*\(|location\.(?:assign|replace)\s*\(|location\.href\s*=|router\.(?:push|replace)\s*\(", re.I)),
    ("storage_write", re.compile(r"(?:localStorage|sessionStorage)\.setItem\s*\(|document\.cookie\s*=", re.I)),
    ("dom_attribute", re.compile(r"\.setAttribute\s*\(\s*[\"'](?:src|href|srcdoc|action|formaction)[\"']", re.I)),
    ("script_creation", re.compile(r"createElement\s*\(\s*[\"']script[\"']|\.src\s*=", re.I)),
    ("dynamic_dispatch", re.compile(r"\[[^\]]*(?:data|type|action|method)[^\]]*\]\s*\(", re.I)),
)

SENSITIVE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("auth", re.compile(r"access_token|refresh_token|trade_token|login|logout|session|oauth|passkey", re.I)),
    ("wallet", re.compile(r"wallet|signMessage|signTypedData|sendTransaction|switchChain", re.I)),
    ("trade", re.compile(r"trade|order|swap|claim|withdraw|bind_wallet|bind_invite", re.I)),
)


def fetch(url: str) -> tuple[int | None, bytes, str | None]:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*;q=0.8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(MAX_BYTES), None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(250_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def fetch_many(urls: Iterable[str]) -> dict[str, tuple[int | None, bytes, str | None]]:
    unique = list(dict.fromkeys(urls))
    output: dict[str, tuple[int | None, bytes, str | None]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(fetch, url): url for url in unique}
        for future in concurrent.futures.as_completed(futures):
            url = futures[future]
            try:
                output[url] = future.result()
            except Exception as exc:  # noqa: BLE001
                output[url] = (None, b"", f"{type(exc).__name__}: {exc}")
    return output


def normalize_js_url(raw: str, base_url: str) -> str | None:
    raw = html.unescape(raw).replace("\\/", "/")
    url = urllib.parse.urljoin(base_url, raw)
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not (parsed.hostname == "gmgn.ai" or (parsed.hostname or "").endswith(".gmgn.ai")):
        return None
    if not (parsed.path.endswith(".js") or ".js?" in url):
        return None
    return url


def discover_js(text: str, base_url: str) -> set[str]:
    found: set[str] = set()
    patterns = (
        r"<script[^>]+src=[\"']([^\"']+)[\"']",
        r"[\"'](https?://[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"'](/_next/static/[^\"']+\.js(?:\?[^\"']*)?)[\"']",
        r"[\"']([^\"']+\.js(?:\?[^\"']*)?)[\"']",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            url = normalize_js_url(match.group(1), base_url)
            if url:
                found.add(url)
    return found


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


def modules(text: str) -> list[tuple[str, int, int, str]]:
    output: list[tuple[str, int, int, str]] = []
    seen: set[int] = set()
    for match in MODULE_START_RE.finditer(text):
        open_index = match.end() - 1
        if open_index in seen:
            continue
        seen.add(open_index)
        close_index = matching_brace(text, open_index)
        if close_index is None:
            continue
        output.append((match.group("id"), match.start(), close_index + 1, text[open_index + 1 : close_index]))
    return output


def named_hits(text: str, patterns: tuple[tuple[str, re.Pattern[str]], ...]) -> list[str]:
    return [name for name, pattern in patterns if pattern.search(text)]


def sentry_files(text: str) -> list[str]:
    found = set(re.findall(r'data-sentry-source-file:["\']([^"\']+)["\']', text))
    found.update(re.findall(r'["\']data-sentry-source-file["\']:["\']([^"\']+)["\']', text))
    return sorted(found)


def listener_contexts(text: str, radius: int = 9000) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for receiver_name, receiver_pattern in RECEIVER_PATTERNS:
        for match in receiver_pattern.finditer(text):
            lo = max(0, match.start() - radius)
            hi = min(len(text), match.end() + radius)
            context = re.sub(r"\s+", " ", text[lo:hi])
            output.append(
                {
                    "receiver": receiver_name,
                    "offset": match.start(),
                    "origin_checks": named_hits(context, ORIGIN_CHECK_PATTERNS),
                    "data_usage": named_hits(context, DATA_PATTERNS),
                    "dangerous_actions": named_hits(context, DANGEROUS_PATTERNS),
                    "sensitive_actions": named_hits(context, SENSITIVE_PATTERNS),
                    "context": context,
                }
            )
    return output


def main() -> int:
    discovered: set[str] = set()
    route_results = fetch_many([urllib.parse.urljoin(BASE, route) for route in ROUTES])
    routes: list[dict[str, Any]] = []
    for url, (status, body, error) in route_results.items():
        text = body.decode("utf-8", errors="replace")
        scripts = discover_js(text, url) if status == 200 else set()
        discovered.update(scripts)
        routes.append({"url": url, "status": status, "error": error, "scripts": len(scripts)})

    scripts: dict[str, str] = {}
    pending = set(discovered)
    while pending and len(scripts) < MAX_SCRIPTS:
        batch = sorted(pending)[: min(40, MAX_SCRIPTS - len(scripts))]
        pending.difference_update(batch)
        for url, (status, body, _error) in fetch_many(batch).items():
            if status != 200 or not body:
                continue
            text = body.decode("utf-8", errors="replace")
            scripts[url] = text
            for child in discover_js(text, url):
                if child not in scripts and len(scripts) + len(pending) < MAX_SCRIPTS:
                    pending.add(child)

    records: list[dict[str, Any]] = []
    module_count = 0
    for script_url, text in scripts.items():
        vendor_chunk = any(
            marker in script_url
            for marker in ("core-vendors", "framework", "webpack", "polyfills")
        )
        for module_id, start, end, body in modules(text):
            module_count += 1
            if not any(pattern.search(body) for _, pattern in RECEIVER_PATTERNS):
                continue
            contexts = listener_contexts(body)
            source_files = sentry_files(body)
            score = 0
            reasons: list[str] = []
            if contexts:
                score += 10
            if source_files:
                score += 15
                reasons.append("application source metadata present")
            if vendor_chunk:
                score -= 25
                reasons.append("vendor/framework chunk")
            else:
                score += 8
            for item in contexts:
                if item["data_usage"]:
                    score += 15
                    reasons.append("message data consumed")
                if not item["origin_checks"]:
                    score += 25
                    reasons.append("no origin/source check near receiver")
                else:
                    score -= 18
                score += 20 * len(item["dangerous_actions"])
                score += 8 * len(item["sensitive_actions"])
            records.append(
                {
                    "score": score,
                    "script_url": script_url,
                    "module_id": module_id,
                    "module_start": start,
                    "module_end": end,
                    "bytes": len(body),
                    "source_files": source_files,
                    "vendor_chunk": vendor_chunk,
                    "reasons": sorted(set(reasons)),
                    "contexts": contexts,
                    "module_origin_checks": named_hits(body, ORIGIN_CHECK_PATTERNS),
                    "module_data_usage": named_hits(body, DATA_PATTERNS),
                    "module_dangerous_actions": named_hits(body, DANGEROUS_PATTERNS),
                    "module_sensitive_actions": named_hits(body, SENSITIVE_PATTERNS),
                    "body": body if len(body) <= 280_000 else None,
                }
            )

    records.sort(key=lambda item: (-item["score"], item["script_url"], item["module_id"]))
    high_value = [
        record
        for record in records
        if any(
            context["data_usage"]
            and not context["origin_checks"]
            and (context["dangerous_actions"] or context["sensitive_actions"])
            for context in record["contexts"]
        )
    ]
    report = {
        "scope": "unauthenticated static analysis of public GMGN JavaScript receivers",
        "routes": routes,
        "summary": {
            "scripts_fetched": len(scripts),
            "modules_scanned": module_count,
            "receiver_modules": len(records),
            "high_value_modules": len(high_value),
            "receivers_without_nearby_origin_check": sum(
                1
                for record in records
                for context in record["contexts"]
                if not context["origin_checks"]
            ),
        },
        "high_value_modules": high_value,
        "records": records,
    }
    out = Path("gmgn_postmessage_receiver_scan.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    for record in high_value:
        print(
            "MODULE",
            json.dumps(
                {
                    "score": record["score"],
                    "script_url": record["script_url"],
                    "module_id": record["module_id"],
                    "source_files": record["source_files"],
                    "module_origin_checks": record["module_origin_checks"],
                    "module_dangerous_actions": record["module_dangerous_actions"],
                    "module_sensitive_actions": record["module_sensitive_actions"],
                },
                ensure_ascii=False,
                sort_keys=True,
            ),
        )
        for context in record["contexts"]:
            if context["data_usage"] and not context["origin_checks"]:
                print(
                    "RECEIVER",
                    json.dumps(
                        {
                            "receiver": context["receiver"],
                            "data_usage": context["data_usage"],
                            "dangerous_actions": context["dangerous_actions"],
                            "sensitive_actions": context["sensitive_actions"],
                            "context": context["context"][:5000],
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

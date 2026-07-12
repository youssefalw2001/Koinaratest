from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from pathlib import Path

BASE = "https://gmgn.ai/"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
MAX_BUNDLES = 360
MAX_BYTES = 20_000_000

MESSAGE_PATTERNS = {
    "addEventListener": r"addEventListener\s*\(\s*[\"']message[\"']",
    "onmessage": r"\.onmessage\s*=",
    "message_port": r"MessageChannel\s*\(|\.port1\.onmessage|\.port2\.onmessage",
}
DATA_PATTERNS = {
    "event.data": r"\b(?:event|evt|e|t|r|n|a|o|i)\.data\b",
    "destructured_data": r"\{[^}]{0,500}\bdata\b[^}]{0,500}\}\s*=\s*(?:event|evt|e|t|r|n|a|o|i)",
}
ORIGIN_PATTERNS = {
    "event.origin": r"\b(?:event|evt|e|t|r|n|a|o|i)\.origin\b",
    "event.source": r"\b(?:event|evt|e|t|r|n|a|o|i)\.source\b",
    "origin_allowlist": r"allowedOrigins?|trustedOrigins?|validOrigins?|originWhitelist|originAllowlist",
    "origin_compare": r"(?:origin|source)\s*(?:===|!==|==|!=)|(?:includes|has)\s*\([^)]*\.origin",
}
SINK_PATTERNS = {
    "innerHTML": r"\.innerHTML\s*=",
    "outerHTML": r"\.outerHTML\s*=",
    "insertAdjacentHTML": r"insertAdjacentHTML\s*\(",
    "dangerouslySetInnerHTML": r"dangerouslySetInnerHTML",
    "document.write": r"document\.write(?:ln)?\s*\(",
    "srcDoc": r"\bsrcDoc\b|\.srcdoc\s*=",
    "eval": r"(^|[^\w$.])eval\s*\(",
    "new Function": r"new\s+Function\s*\(",
    "script.src": r"createElement\s*\(\s*[\"']script[\"']|\.src\s*=",
    "window.open": r"window\.open\s*\(",
    "location": r"(?:window\.)?location(?:\.href)?\s*=|location\.(?:assign|replace)\s*\(",
    "iframe.src": r"createElement\s*\(\s*[\"']iframe[\"']|\.contentWindow\b|\.src\s*=",
}
SANITIZER_PATTERNS = {
    "DOMPurify": r"DOMPurify|\.sanitize\s*\(",
    "safeUrl": r"isSafeUrl|safeUrl|sanitizeUrl|validateUrl",
    "escape": r"escapeHTML|htmlEscape|encodeURI(?:Component)?",
    "text": r"textContent\s*=|createTextNode\s*\(",
}


def fetch(url: str, limit: int = MAX_BYTES):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "text/html,application/javascript,*/*"},
    )
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return response.status, response.read(limit + 1)[:limit], None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(200_000), str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, b"", f"{type(exc).__name__}: {exc}"


def script_urls(text: str, base_url: str) -> set[str]:
    output: set[str] = set()
    for pattern in (
        r'<script[^>]+src=["\']([^"\']+)["\']',
        r'["\']([^"\']+\.js(?:\?[^"\']*)?)["\']',
    ):
        for match in re.finditer(pattern, text, re.I):
            url = urllib.parse.urljoin(base_url, html.unescape(match.group(1)))
            parsed = urllib.parse.urlparse(url)
            if url.startswith("https://gmgn.ai/") and (
                parsed.path.endswith(".js") or ".js?" in url
            ):
                output.add(url)
    return output


def manifest_routes(text: str):
    match = re.search(r'["\'](/_next/static/[^"\']+/_buildManifest\.js)["\']', text)
    if not match:
        return None, {}
    url = urllib.parse.urljoin(BASE, match.group(1))
    status, body, _ = fetch(url, 8_000_000)
    if status != 200:
        return url, {}
    source = body.decode(errors="replace")
    routes: dict[str, list[str]] = {}
    for item in re.finditer(
        r'["\'](/[^"\']*)["\']\s*:\s*\[([^\]]*)\]', source
    ):
        chunks = re.findall(r'["\']([^"\']+\.js)["\']', item.group(2))
        if chunks:
            routes[item.group(1)] = [urllib.parse.urljoin(url, chunk) for chunk in chunks]
    return url, routes


def dynamic_chunks(text: str, url: str) -> set[str]:
    output = {
        urllib.parse.urljoin(url, value)
        for value in re.findall(
            r'["\']([^"\']*(?:chunks|pages)/[^"\']+\.js)["\']', text
        )
    }
    root = re.match(r"(https://[^/]+/_next/static/)", url)
    base = root.group(1) if root else urllib.parse.urljoin(url, "/_next/static/")
    for number, digest in re.findall(
        r'(\d{2,6})\s*:\s*["\']([a-f0-9]{8,32})["\']', text
    ):
        output.add(urllib.parse.urljoin(base, f"chunks/{number}-{digest}.js"))
    return output


def split_modules(text: str) -> dict[str, str]:
    patterns = (
        r"(?:^|[,{}])([0-9]{2,8})\s*[:=]\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{",
        r"(?:^|[,{}])([0-9]{2,8})\s*:\s*function\s*\([^)]*\)\s*\{",
    )
    matches = []
    for pattern in patterns:
        matches = list(re.finditer(pattern, text))
        if matches:
            break
    output: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.start(1)
        end = matches[index + 1].start(1) if index + 1 < len(matches) else len(text)
        if 60 < end - start < 3_000_000:
            output[match.group(1)] = text[start:end]
    return output


def imports(text: str) -> set[str]:
    return set(re.findall(r"(?<![\w$])r\(\s*(\d{2,8})\s*\)", text))


def hits(patterns: dict[str, str], text: str) -> dict[str, list[int]]:
    return {
        name: [match.start() for match in re.finditer(pattern, text, re.I)][:80]
        for name, pattern in patterns.items()
        if re.search(pattern, text, re.I)
    }


def around(text: str, position: int, radius: int = 7000) -> str:
    return re.sub(
        r"\s+", " ", text[max(0, position - radius) : min(len(text), position + radius)]
    )


def source_files(text: str) -> list[str]:
    return sorted(
        set(
            re.findall(
                r'data-sentry-source-file["\']?\s*:\s*["\']([^"\']+)', text
            )
        )
    )


def api_literals(text: str) -> list[str]:
    return sorted(
        set(
            re.findall(
                r'["\'](/(?:tapi|xapi|vas|api|defi|account|rebate|quotation)/[^"\'`\s]{1,180})["\']',
                text,
            )
        )
    )


def main() -> int:
    root_status, root_body, root_error = fetch(BASE, 3_000_000)
    page = root_body.decode(errors="replace")
    manifest_url, routes = manifest_routes(page)
    queue = deque(script_urls(page, BASE))
    for values in routes.values():
        queue.extend(values)

    seen: set[str] = set()
    modules: dict[str, str] = {}
    module_bundle: dict[str, str] = {}
    while queue and len(seen) < MAX_BUNDLES:
        url = queue.popleft()
        if url in seen or not url.startswith("https://gmgn.ai/"):
            continue
        seen.add(url)
        status, body, _ = fetch(url)
        if status != 200 or not body:
            continue
        text = body.decode(errors="replace")
        queue.extend(item for item in dynamic_chunks(text, url) if item not in seen)
        for module_id, module_text in split_modules(text).items():
            if module_id not in modules or len(module_text) > len(modules[module_id]):
                modules[module_id] = module_text
                module_bundle[module_id] = url
        time.sleep(0.07)

    reverse: dict[str, set[str]] = defaultdict(set)
    for module_id, text in modules.items():
        for dependency in imports(text):
            reverse[dependency].add(module_id)

    findings = []
    for module_id, text in modules.items():
        message_hits = hits(MESSAGE_PATTERNS, text)
        if not message_hits:
            continue
        data_hits = hits(DATA_PATTERNS, text)
        origin_hits = hits(ORIGIN_PATTERNS, text)
        sink_hits = hits(SINK_PATTERNS, text)
        sanitizer_hits = hits(SANITIZER_PATTERNS, text)
        entries = []
        for listener_name, positions in message_hits.items():
            for position in positions:
                window = around(text, position)
                local_data = list(hits(DATA_PATTERNS, window))
                local_origin = list(hits(ORIGIN_PATTERNS, window))
                local_sinks = list(hits(SINK_PATTERNS, window))
                local_sanitizers = list(hits(SANITIZER_PATTERNS, window))
                score = (
                    5 * bool(local_data)
                    + 5 * bool(local_sinks)
                    + 2 * bool(api_literals(window))
                    - 6 * bool(local_origin)
                    - 3 * bool(local_sanitizers)
                )
                entries.append(
                    {
                        "listener": listener_name,
                        "offset": position,
                        "score": score,
                        "data": local_data,
                        "origin_checks": local_origin,
                        "sinks": local_sinks,
                        "sanitizers": local_sanitizers,
                        "api_literals": api_literals(window),
                        "snippet": window,
                    }
                )
        parents = []
        for parent in sorted(reverse.get(module_id, set()))[:30]:
            parent_text = modules.get(parent, "")
            parents.append(
                {
                    "module": parent,
                    "bundle": module_bundle.get(parent),
                    "source_files": source_files(parent_text),
                    "api_literals": api_literals(parent_text),
                }
            )
        findings.append(
            {
                "module": module_id,
                "bundle": module_bundle.get(module_id),
                "bytes": len(text),
                "source_files": source_files(text),
                "message_handlers": list(message_hits),
                "data_sources": list(data_hits),
                "origin_checks": list(origin_hits),
                "sinks": list(sink_hits),
                "sanitizers": list(sanitizer_hits),
                "api_literals": api_literals(text),
                "max_score": max((entry["score"] for entry in entries), default=0),
                "entries": entries,
                "parents": parents,
                "text": text[:900_000],
            }
        )

    findings.sort(
        key=lambda item: (
            item["max_score"],
            bool(item["sinks"]),
            bool(item["data_sources"]),
            not bool(item["origin_checks"]),
        ),
        reverse=True,
    )
    report = {
        "generated_at": int(time.time()),
        "scope": "Public static postMessage handler analysis only",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "bundles": len(seen),
        "modules": len(modules),
        "handler_modules": len(findings),
        "findings": findings,
        "summary": {
            "bundles": len(seen),
            "modules": len(modules),
            "handler_modules": len(findings),
            "high_score_without_origin": sum(
                item["max_score"] >= 8 and not item["origin_checks"] for item in findings
            ),
        },
        "candidates": findings[:100],
        "canaries": [],
    }
    Path("gmgn_xss_focus_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    lines = [
        "# GMGN postMessage XSS Scan",
        "",
        f"Bundles: **{len(seen)}**",
        f"Modules: **{len(modules)}**",
        f"Handler modules: **{len(findings)}**",
        "",
    ]
    for finding in findings[:60]:
        lines.append(
            f"- score {finding['max_score']} module `{finding['module']}` "
            f"handlers={finding['message_handlers']} data={finding['data_sources']} "
            f"origin={finding['origin_checks']} sinks={finding['sinks']} "
            f"files={finding['source_files']}"
        )
    Path("gmgn_xss_focus_verdict.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(report["summary"], indent=2))
    for finding in findings[:30]:
        print(
            "CAND",
            json.dumps(
                {
                    key: finding.get(key)
                    for key in (
                        "module",
                        "max_score",
                        "source_files",
                        "message_handlers",
                        "data_sources",
                        "origin_checks",
                        "sinks",
                        "sanitizers",
                        "api_literals",
                    )
                },
                ensure_ascii=False,
            ),
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import concurrent.futures
import html
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

BASE = "https://gmgn.ai/"
NEXT_BASE = "https://gmgn.ai/_next/"
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

SOURCE_TERMS = (
    "/tapi/v1/fourmeme/bind_invite",
    "/tapi/v1/fourmeme/invite_info",
    "fourmeme/bind_invite",
    "fourmeme/invite_info",
    "bind_invite",
    "invite_info",
    "invite_code",
    "invited_code",
    "invited_address",
    "referral_code",
)
SINK_TERMS = (
    "dangerouslySetInnerHTML",
    ".innerHTML",
    "innerHTML=",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "DOMParser",
)
SANITIZER_TERMS = (
    "DOMPurify",
    ".sanitize(",
    "sanitize:",
    "escapeHTML",
    "escapeHtml",
)
TOKEN_TERMS = (
    "localStorage",
    "account_token_",
    "access_token",
    "refresh_token",
    "trade_token",
)
TARGETS = SOURCE_TERMS + SINK_TERMS + SANITIZER_TERMS + TOKEN_TERMS

MAX_BYTES = 14_000_000
MAX_BUNDLES = 300
MAX_WORKERS = 6
WINDOW = 1_300
MODULE_CONTEXT = 2_000

MODULE_START = re.compile(
    r"(?:(?<=\{)|(?<=,))(\d{3,}):(?:function\([^)]*\)\{|\([^)]*\)=>\{)"
)


def fetch(url: str) -> tuple[str, int | None, dict[str, str], bytes, str | None]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/javascript,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = resp.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                body = body[:MAX_BYTES]
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return url, resp.status, headers, body, None
    except urllib.error.HTTPError as exc:
        body = exc.read(150_000)
        return url, exc.code, {k.lower(): v for k, v in exc.headers.items()}, body, str(exc)
    except Exception as exc:  # noqa: BLE001
        return url, None, {}, b"", f"{type(exc).__name__}: {exc}"


def normalize_script_url(raw: str, source_url: str = BASE) -> str | None:
    raw = html.unescape(raw).replace("\\/", "/")
    raw = raw.strip('"\'` ')
    if not raw or ".js" not in raw:
        return None

    if raw.startswith("https://") or raw.startswith("http://"):
        url = raw
    elif raw.startswith("/_next/"):
        url = urllib.parse.urljoin(BASE, raw)
    elif raw.startswith("static/"):
        url = urllib.parse.urljoin(NEXT_BASE, raw)
    elif raw.startswith("_next/"):
        url = urllib.parse.urljoin(BASE, "/" + raw)
    elif raw.startswith("/"):
        url = urllib.parse.urljoin(BASE, raw)
    else:
        url = urllib.parse.urljoin(source_url, raw)

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.path.endswith(".js"):
        return None
    return url


def extract_script_urls(text: str, source_url: str = BASE) -> set[str]:
    found: set[str] = set()
    patterns = (
        r'<script[^>]+src=["\']([^"\']+)["\']',
        r'["\']((?:https?:)?//[^"\']+\.js(?:\?[^"\']*)?)["\']',
        r'["\']((?:/)?_next/static/[^"\']+\.js(?:\?[^"\']*)?)["\']',
        r'["\'](static/(?:chunks|[^/]+)/[^"\']+\.js(?:\?[^"\']*)?)["\']',
        r'["\']([^"\']*static/chunks/[^"\']+\.js(?:\?[^"\']*)?)["\']',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.I):
            url = normalize_script_url(match.group(1), source_url)
            if url:
                found.add(url)
    return found


def evaluate_build_manifest(text: str) -> dict[str, Any] | None:
    node = r"""
const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync(0, 'utf8');
const context = { self: {} };
vm.createContext(context);
try {
  vm.runInContext(code, context, { timeout: 1500 });
  const value = context.self.__BUILD_MANIFEST || null;
  process.stdout.write(JSON.stringify(value));
} catch (error) {
  process.stderr.write(String(error));
  process.exit(2);
}
"""
    try:
        result = subprocess.run(
            ["node", "-e", node],
            input=text,
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        value = json.loads(result.stdout)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def iter_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from iter_strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_strings(child)


def clean_snippet(text: str, start: int, end: int) -> str:
    return re.sub(r"\s+", " ", text[max(0, start):min(len(text), end)])


def windows(text: str, needle: str, limit: int = 12) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    cursor = 0
    while len(output) < limit:
        position = text.find(needle, cursor)
        if position < 0:
            break
        output.append(
            {
                "offset": position,
                "snippet": clean_snippet(
                    text,
                    position - WINDOW,
                    position + len(needle) + WINDOW,
                ),
            }
        )
        cursor = position + len(needle)
    return output


def split_modules(text: str) -> list[tuple[str, int, int, str]]:
    starts = list(MODULE_START.finditer(text))
    modules: list[tuple[str, int, int, str]] = []
    for index, match in enumerate(starts):
        start = match.start()
        end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
        modules.append((match.group(1), start, end, text[start:end]))
    return modules


def module_findings(text: str) -> dict[str, list[dict[str, Any]]]:
    source_modules: list[dict[str, Any]] = []
    same_module_source_sink: list[dict[str, Any]] = []
    exact_endpoint_modules: list[dict[str, Any]] = []

    for module_id, start, end, body in split_modules(text):
        sources = [term for term in SOURCE_TERMS if term in body]
        if not sources:
            continue
        sinks = [term for term in SINK_TERMS if term in body]
        sanitizers = [term for term in SANITIZER_TERMS if term in body]
        exact_endpoints = [term for term in SOURCE_TERMS[:4] if term in body]

        source_positions = [body.find(term) for term in sources]
        first_position = min(position for position in source_positions if position >= 0)
        snippet = clean_snippet(
            body,
            first_position - MODULE_CONTEXT,
            first_position + MODULE_CONTEXT * 2,
        )
        entry = {
            "module_id": module_id,
            "module_start": start,
            "module_end": end,
            "module_bytes": len(body),
            "sources": sources,
            "sinks": sinks,
            "sanitizers": sanitizers,
            "snippet": snippet,
        }
        source_modules.append(entry)
        if sinks:
            same_module_source_sink.append(entry)
        if exact_endpoints:
            exact_endpoint_modules.append(entry)

    return {
        "source_modules": source_modules[:200],
        "same_module_source_sink": same_module_source_sink[:100],
        "exact_endpoint_modules": exact_endpoint_modules[:100],
    }


def scan_bundle(url: str, status: int | None, headers: dict[str, str], body: bytes, error: str | None) -> dict[str, Any]:
    text = body.decode("utf-8", errors="replace")
    counts = {term: text.count(term) for term in TARGETS if term in text}
    module_data = module_findings(text)
    evidence = {
        term: windows(text, term)
        for term in TARGETS
        if term in text and (
            term in SOURCE_TERMS
            or term in SANITIZER_TERMS
            or term in {"account_token_", "access_token", "refresh_token", "trade_token"}
        )
    }
    return {
        "url": url,
        "status": status,
        "error": error,
        "bytes": len(body),
        "content_type": headers.get("content-type"),
        "counts": counts,
        "evidence": evidence,
        **module_data,
    }


def main() -> int:
    _, root_status, root_headers, root_body, root_error = fetch(BASE)
    root_text = root_body.decode("utf-8", errors="replace")
    initial_urls = extract_script_urls(root_text, BASE)

    fetched: dict[str, tuple[int | None, dict[str, str], bytes, str | None]] = {}
    pending = set(initial_urls)
    build_manifest: dict[str, Any] | None = None
    manifest_url: str | None = None

    # Two discovery rounds: initial HTML scripts, then route/dynamic scripts exposed by manifests.
    for discovery_round in range(3):
        batch = sorted(url for url in pending if url not in fetched)[:MAX_BUNDLES - len(fetched)]
        if not batch:
            break
        print(f"DISCOVERY ROUND {discovery_round + 1}: fetching {len(batch)} scripts", flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            results = list(pool.map(fetch, batch))

        newly_discovered: set[str] = set()
        for url, status, headers, body, error in results:
            fetched[url] = (status, headers, body, error)
            text = body.decode("utf-8", errors="replace")
            newly_discovered.update(extract_script_urls(text, url))

            if url.endswith("/_buildManifest.js") or url.endswith("_buildManifest.js"):
                manifest_url = url
                manifest_value = evaluate_build_manifest(text)
                if manifest_value:
                    build_manifest = manifest_value
                    for value in iter_strings(manifest_value):
                        normalized = normalize_script_url(value, url)
                        if normalized:
                            newly_discovered.add(normalized)

        pending.update(newly_discovered)
        if len(fetched) >= MAX_BUNDLES:
            break

    scanned_bundles: list[dict[str, Any]] = []
    aggregate_counts = {term: 0 for term in TARGETS}
    source_module_total = 0
    same_module_total = 0
    exact_endpoint_total = 0

    for url, (status, headers, body, error) in sorted(fetched.items()):
        scanned = scan_bundle(url, status, headers, body, error)
        for term, count in scanned["counts"].items():
            aggregate_counts[term] += count
        source_module_total += len(scanned["source_modules"])
        same_module_total += len(scanned["same_module_source_sink"])
        exact_endpoint_total += len(scanned["exact_endpoint_modules"])
        if scanned["counts"] or scanned["source_modules"]:
            scanned_bundles.append(scanned)

    route_summary: dict[str, Any] = {}
    if build_manifest:
        for route, values in build_manifest.items():
            if not isinstance(route, str) or not route.startswith("/"):
                continue
            strings = list(iter_strings(values))
            route_summary[route] = {
                "scripts": sorted(
                    {
                        normalized
                        for value in strings
                        if (normalized := normalize_script_url(value, manifest_url or BASE))
                    }
                ),
                "relevant_name": any(
                    token in route.lower()
                    for token in ("invite", "referral", "rebate", "earn", "wallet", "fourmeme")
                ),
            }

    report: dict[str, Any] = {
        "generated_at": int(time.time()),
        "scope": "unauthenticated public frontend static analysis only",
        "root": {
            "url": BASE,
            "status": root_status,
            "error": root_error,
            "bytes": len(root_body),
            "content_type": root_headers.get("content-type"),
            "content_security_policy": root_headers.get("content-security-policy"),
            "content_security_policy_report_only": root_headers.get(
                "content-security-policy-report-only"
            ),
            "x_content_type_options": root_headers.get("x-content-type-options"),
            "referrer_policy": root_headers.get("referrer-policy"),
        },
        "manifest": {
            "url": manifest_url,
            "evaluated": build_manifest is not None,
            "routes": route_summary,
        },
        "bundle_urls": sorted(fetched),
        "bundles": scanned_bundles,
        "summary": {
            "initial_bundles_discovered": len(initial_urls),
            "total_bundles_fetched": len(fetched),
            "bundles_with_relevant_hits": len(scanned_bundles),
            "aggregate_counts": {k: v for k, v in aggregate_counts.items() if v},
            "source_modules": source_module_total,
            "same_module_source_sink_modules": same_module_total,
            "exact_fourmeme_endpoint_modules": exact_endpoint_total,
            "limitations": [
                "Same-module occurrence narrows candidates but does not itself prove runtime data flow.",
                "Browser execution and authenticated response rendering are not tested.",
                "No credentials, cookies, POST requests, or user-controlled payloads were used.",
            ],
        },
    }

    out = Path("xss_static_recon_report.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["root"], indent=2))
    print(json.dumps(report["summary"], indent=2))
    relevant_routes = {
        route: data
        for route, data in route_summary.items()
        if data.get("relevant_name")
    }
    print("RELEVANT ROUTES", json.dumps(relevant_routes, indent=2))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

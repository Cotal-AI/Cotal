---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal daemon status --space <name>` now exits 2 when the background service does not host that Manager and explains where to look next. Both forms of status report `DEPENDENCY_UNAVAILABLE` with the path and recovery advice when the service cannot read its registrations. Status-only diagnostics that name private spaces or paths stay out of telemetry.

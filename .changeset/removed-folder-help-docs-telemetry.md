---
"@cotal-ai/cli": patch
---

From a folder that no longer exists, `cotal help` and bare `cotal` said "The local space or defaults could not be read. Status reports the affected records.", while `status` there refuses, and `cotal docs` and `cotal telemetry` refused with "this folder no longer exists" though neither uses the folder. `docs` and `telemetry` now run there, and `help` says the folder no longer exists and to `cd` to an existing one.

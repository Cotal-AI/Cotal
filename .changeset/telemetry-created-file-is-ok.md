---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal telemetry <level>` now reports `ok` when the run creates the settings file, even at the default level. With no `telemetry.json`, `cotal telemetry regular` or `on`, also under `COTAL_TELEMETRY=minimal`, created the file and reported a `no-op`.

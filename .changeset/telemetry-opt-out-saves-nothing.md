---
"@cotal-ai/cli": patch
---

`cotal telemetry <level>` no longer creates or rewrites the settings file while the environment forces telemetry off. Under `DO_NOT_TRACK`, `COTAL_TELEMETRY_DISABLED` or `COTAL_TELEMETRY=off` it created `~/.cotal/telemetry.json` with an install id, though the docs say the file is neither read nor created then, and it reported `ok` on every repeat while the receipt showed no install id. It now saves nothing and reports a `no-op` with an `ENVIRONMENT_OPT_OUT` warning that names the variable to unset.

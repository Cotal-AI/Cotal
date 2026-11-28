---
"@cotal-ai/cli": patch
---

Keep the existing broker store's path and filesystem access diagnostics local when startup or a roster read refuses. Telemetry still reports the permission error code.

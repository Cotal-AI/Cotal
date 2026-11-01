---
"@cotal-ai/connector-opencode": patch
---

A launcher whose agent session never comes up now exits 1 even when the opencode server exits cleanly on SIGTERM, instead of reporting the failed boot as exit 0.

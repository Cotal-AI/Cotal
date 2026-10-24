---
"@cotal-ai/cli": patch
---

A `COTAL_TELEMETRY_URL` that is not an `http` or `https` URL was reported by `cotal telemetry` as where events go, and every send to it failed unseen. It now refuses `USAGE_INVALID`, exit 1, before the command runs whenever the level in force sends events, and `cotal telemetry` refuses it at every level.

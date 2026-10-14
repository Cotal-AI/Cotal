---
"@cotal-ai/connector-core": patch
---

`cotal_status` with an activity and no status now changes only the activity. It used to read the current status when the tool ran and write it back behind any status write still queued, so a pending `waiting` was published as `working` with its condition cleared, and a pending turn-end `idle` left the seat reading `working`.

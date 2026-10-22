---
"@cotal-ai/web": patch
---

A `web` dashboard service whose port is already in use now releases its PID slot before it exits. Before, the slot stayed held after the failed start, and every later `service start` in that space refused with `LIFECYCLE_BLOCKED` until `cotal down` cleared it.

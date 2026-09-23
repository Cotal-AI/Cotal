---
"@cotal-ai/cli": patch
---

Bare `cotal down` now names a live unowned broker even when other owned components were running. The probe no longer runs only on a down that owned nothing: a detached web or any other recorded component stops and clears its artifacts first, then a registered broker that answers with no `nats.pid` is named with its address, `down` exits 1, and the broker is left to whatever started it.

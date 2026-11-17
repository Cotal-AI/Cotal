---
"@cotal-ai/cli": patch
---

`cotal up` now starts the broker again on a new websocket port when another process took the one it picked before the broker could bind it, instead of failing with "Unable to listen for websocket connections".

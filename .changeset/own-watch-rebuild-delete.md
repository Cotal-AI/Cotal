---
"@cotal-ai/core": patch
---

Skip an ordered watch rebuild's predecessor delete when the endpoint recorded the watch as its own and the connection's known publish claims exclude that request. This avoids repeated permission refusals without widening consumer-delete grants. The predecessor remains for broker inactive-threshold cleanup.

---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-hermes": patch
---

The Hermes bridge's local Unix-socket listener now authenticates the first frame of every connection against the launch's control token, dropping an unauthenticated or wrongly-tokened connection before it ever reaches the adapter or a tool call, and the Python-side client now presents that same token on every connect and reconnect.

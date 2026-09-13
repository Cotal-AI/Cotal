---
"@cotal-ai/connector-jcode": patch
---

Start a Jcode seat whose private home has an empty `sessions/` directory instead of dying as
`startup failed (unknown)`. The connector skips the panicking list call when that directory is
empty, redials after any listing death, and names the panic text and sessions path when recovery
cannot create a session.

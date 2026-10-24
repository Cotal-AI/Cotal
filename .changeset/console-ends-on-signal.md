---
"@cotal-ai/cli": patch
---

Ctrl-C, SIGINT and SIGTERM end `cotal console` at any time again. Once its connection was closed for good, after `down`, a credential's expiry or `reset space`, the line stream ignored all three until SIGKILL, and Ctrl-C did nothing in the full-screen view. `console --plain` now also ends on its own when its credential can no longer connect, with the refusal a one-shot command with that credential gets, and a lost connection is one line while it is re-established.

---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 2.x adapter ignores execution events from other sessions before its own session id is known, so another session's turn can no longer leave the adapter permanently busy.

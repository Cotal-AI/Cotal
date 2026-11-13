---
"@cotal-ai/connector-claude-code": patch
---

The Claude Code plugin no longer rewrites a `cotal_connect` call to add the session. The server uses the one native session it has already bound.

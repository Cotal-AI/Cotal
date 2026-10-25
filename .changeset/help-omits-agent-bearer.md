---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

`cotal help` no longer lists `cotal agent-bearer`, the plumbing spawned user-auth agents exec to fetch a fresh bearer; its docs say people never run it. It is still registered, still runs for those agents, and `cotal help agent-bearer` still prints its help.

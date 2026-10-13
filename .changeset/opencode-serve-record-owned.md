---
"@cotal-ai/connector-opencode": patch
---

The OpenCode launcher now removes the agent's `serve.pid` record only while it still names its own server. Its exit handler used to remove the record unconditionally, so a launcher whose handler ran after the next launch of the name had started removed that server's record, and the launch after that started a second server on the same database. The record now holds the server's pid and a token minted per launch, and the handler removes it only when the token is its own. A launch also no longer removes a record naming a server that is gone, since a concurrent launch may have just replaced it; the new server's record overwrites it.

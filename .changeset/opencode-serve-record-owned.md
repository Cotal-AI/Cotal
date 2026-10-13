---
"@cotal-ai/connector-opencode": patch
---

The OpenCode launcher now records each server in a file of its own, `serve.<token>.pid` in the agent's directory, and removes only that file when the server exits. Every launch of a name used to share one `serve.pid`, and the launcher's exit handler removed it unconditionally, so a handler that ran after the next launch had started its server removed that server's record, and the launch after that started a second server on the same database. A launch now checks every record in the directory, including a `serve.pid` left by an earlier version, refuses while any names a running server, and removes the records of servers that are gone.

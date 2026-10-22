---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Recover a signed-in native Claude conversation whose identity retirement is still pending. Disconnect, every routed tool and reconnect now report one disconnected state with the mesh's retirement phase and the available retry, instead of advising a reconnect that the same conversation then refused. Reconnecting retries the pending retirement and connects with a new identity once the mesh confirms it, including after the plugin server restarts. Each signed-in connection also retires the same mesh's saved conversation identities whose plugin server has provably exited, keeping live and unknown ones and retaining any retirement that does not finish.

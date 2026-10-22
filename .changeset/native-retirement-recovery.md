---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Recover a signed-in native Claude conversation whose identity retirement is still pending. Disconnect, every routed tool and reconnect now report one disconnected state with the mesh's retirement phase and the available retry, instead of advising a reconnect that the same conversation then refused. Reconnecting retries the pending retirement and connects with a new identity once the mesh confirms it, including after the plugin server restarts. After each signed-in connection, the plugin retires the same mesh's saved conversation identities whose plugin server process no longer exists, through the new `cotal app-identity reap` plumbing. It runs in the background, so a connection never waits for it, and it keeps any identity whose server process still exists and retains any retirement that does not finish. The same conversation from another plugin server reuses a saved identity only once the server that held it no longer exists, so a live server keeps its identity even when its process start time reads differently, as macOS `ps` does across time zones and locales.

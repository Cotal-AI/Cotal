---
"@cotal-ai/core": patch
"@cotal-ai/delivery": patch
"@cotal-ai/connector-core": patch
---

The delivery daemon's timer writer now presents the credential the daemon holds on every connect and
reconnects onto each renewed credential the daemon adopts. The broker no longer closes the writer's
connection when the credential it dialed with expires, and a re-dial never presents an expired
credential, so the writer no longer goes down for a few seconds at each expiry. `standaloneConnectOpts`
accepts a creds getter that is read on every attempt, and `CotalEndpoint.wireCreds()` returns the
endpoint's checked credential.

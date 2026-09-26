---
"@cotal-ai/connector-core": patch
---

Consult `presenceView()` on every roster read in the connector, so a partial reconnect refill is not rendered or enforced as a complete roster: `cotal_roster` and `cotal_orientation` label an `unpopulated` view as a snapshot still in progress and a `stale` view as last-known, and a send or DM to a name that cannot be verified waits once for the presence snapshot and is then refused with the observer's condition instead of reporting a live peer as absent.

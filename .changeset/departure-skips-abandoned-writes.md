---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-opencode": patch
---

Let a cooperative teardown publish departure after it has given up waiting on a presence write. Presence writes are serialized, so the departure publish queued behind the very write the teardown's intake bound had just abandoned: the wait ended, offline never published, the seat kept its last status until its presence TTL expired, and the plugin process never reached its exit. The agent gains `abandonPresenceWrites()`, which the teardown calls only on the path where it announces the bound expired; ordering behind writes that do settle inside the bound is unchanged (#2207).

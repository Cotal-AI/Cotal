---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": patch
---

Agent seats no longer watch presence. Every member of a space received every other member's heartbeat every two seconds, so an idle space of K seats moved K² presence deliveries per heartbeat. An idle 400-seat space pushed about 35 MB/s out of the broker. A seat now reads the roster when a tool needs it: `cotal_roster`, `cotal_orientation`, a DM to a name, a send with `@mentions`, and the anycast holder count. An idle seat now costs the broker one put, one ack and one delivery to each liveness watcher per heartbeat, whatever the size of its space. The manager, the delivery daemon, `cotal chat` and the dashboard still watch.

The new `CotalEndpoint.readPresence()` makes batched Direct Gets of the presence bucket. It binds no consumer, applies the same reader rules as the watch, and reads a record older than the liveness window as offline. A peer that an earlier read saw stays on the roster as offline after it leaves the bucket. When a read fails, the seat refuses to say a name is absent: the error names the failed read instead of reporting an unknown peer. The agent credential gains `$JS.API.DIRECT.GET.KV_cotal_presence_<space>` (SPEC §6 and Appendix B). A credential minted before this release lacks that grant, and its reads are refused with the grant named, so upgrade the manager and auth service before the connectors. Whole-bucket Direct Get reads, including `readOnce`, now page past 1024 keys instead of refusing the read.

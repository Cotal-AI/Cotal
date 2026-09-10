---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

Report a refused presence-KV write by naming the bucket and how long writes have been refused, instead of asserting the mesh is unreachable while the transport is connected. A latched presence bucket still opens and watches cleanly, so only the write reveals it; bind now fails with that detail rather than a bare timeout, and `cotal_connection_status` carries a distinct `presenceWriteFailure` field. The record is connection-scoped: it is cleared whenever a connection is torn down, rebuilt or stopped, so a later failure on a different connection cannot inherit it and be described as a bucket refusal.

Clearing on teardown is not sufficient on its own, because a presence put can still be in flight when the teardown runs. A rebind reaches `publishPresence` through the empty-bucket path and nothing awaits that flight, so a put started on one connection could settle after the record was cleared and write its refusal onto a stopped endpoint or onto the connection that replaced it. The put now carries the same epoch fence the presence watch bind takes: a put that outlives its epoch still throws to its caller, and it no longer writes presence-refusal state that belongs to a later connection. A late success is fenced the same way, so it cannot erase a refusal the current connection established from its own evidence.

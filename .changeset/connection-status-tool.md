---
"@cotal-ai/connector-core": minor
---

Add `cotal_connection_status`, a read-only MCP tool reporting this session's mesh connection as one
of five distinct states: ready, degraded (bound while the transport underneath is down), connecting
(transport live, bind unfinished), disconnected, and stopped (shut down deliberately, which is not a
fault). It also reports the raw facts the state is derived from, the buffered inbox count, and the
measured last successful inbox drain. A retained failure is reported as the current reason only while
it is one, and as a post-mortem on a stopped session.

`MeshAgent` gains `stopping` and `connectionState`. Without `stopping` a deliberate shutdown and a
lost connection are indistinguishable, because `stop()` clears readiness and transport together.

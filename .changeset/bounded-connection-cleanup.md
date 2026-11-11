---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/auth": patch
"@cotal-ai/delivery": patch
"@cotal-ai/runtime": patch
"@cotal-ai/linear": patch
"@cotal-ai/connector-core": patch
---

Connection teardown no longer hangs when the broker closes a connection during its drain.
Use the shared `drainAndClose` helper to end the drain wait on terminal closure or a short grace period, then close the connection.

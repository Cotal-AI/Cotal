---
"@cotal-ai/manager": patch
---

The manager's exit watch now calls its handler only while the caller still watches the handle, for a runtime that streams its exit as well as for one it polls. A streamed exit used to reach the handler after the caller had stopped watching, and a child that had already exited reached it twice. The handler now runs at most once per watch, and the stream subscription ends at the exit. A polled exit whose proof settles after the caller stopped watching no longer reaches the handler. The manager's own exit watch relies on this instead of repeating the check.

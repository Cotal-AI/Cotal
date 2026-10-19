---
"@cotal-ai/runtime": patch
---

The runtime's event-loop lag observer now releases its tick timer with a plain `unref()` call. The
optional `unref?.()` call was explained as keeping the file loadable under DOM typing, but DOM
typing rejects both forms the same way, and on Node the method is always present. On a host whose
timers lack `unref`, the optional call silently left the tick holding the process open. The plain
call now throws a `TypeError` there.

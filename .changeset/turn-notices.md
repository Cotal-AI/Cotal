---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

Deliver run turns to idle seats by notice instead of a 15-second poll. The manager publishes a data-free turn notice on the seat's own reply rail whenever the seat's pending turns change, and repeats it every 5 seconds until the seat pulls a new turn. The seat pulls `turn-pending` when a notice arrives, when it connects, and after a reconnect while it holds a turn. A seat's manager-call bearer is reused for its lifetime minus two minutes, shared by concurrent calls, and dropped after any failed call. An idle manager-launched seat no longer exchanges a manager-call bearer or opens a control connection every 15 seconds. A seat under a manager that predates notices keeps pulling every 15 seconds and logs that once. The notice needs no new grant: only the manager instance's serve credential can publish it, and a seat can read only its own.

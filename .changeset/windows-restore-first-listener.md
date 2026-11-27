---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

A backup restore on a host that cannot list process command lines now starts its first listener. If that listener was spawned but its pid was never published, a later attempt refuses instead of starting a second listener. A published pid whose creation time does not match the recorded listener does not block.

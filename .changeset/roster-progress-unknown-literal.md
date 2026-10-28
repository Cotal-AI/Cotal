---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

The console roster and the web dashboard roster no longer call `progressSignal` with a literal `undefined`. Neither surface has a last-assistant observation, so a working row renders `progress unknown` directly and every other row keeps its heartbeat age.

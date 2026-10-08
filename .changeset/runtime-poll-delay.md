---
"@cotal-ai/runtime": patch
---

The runtime's poll and retry loops now wait through one shared helper, whose timer never holds the process open. Each loop used to build its own wait inline, and the copies disagreed: the checkpoint answer's mint-window retry kept the process alive while every other wait did not. That retry now follows the same rule, which changes nothing a caller can see, because it reads over a broker connection that already keeps the process alive.

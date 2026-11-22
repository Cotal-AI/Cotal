---
"@cotal-ai/runtime": patch
---

Refuse a simulation results file whose clock.start is past the safe-integer range, so a one-millisecond sleep is never reported as zero elapsed time; name the supported range and how to fix it.

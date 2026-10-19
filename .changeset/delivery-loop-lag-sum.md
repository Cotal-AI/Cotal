---
"@cotal-ai/delivery": patch
---

The delivery daemon's loop-lag meter now sums the lag of each late timer firing. It used to merge charges by their wall-clock timestamps, a leftover from the removed broker probe, so when the clock stepped backwards between two stalls it counted them as one and the broker-loss check excused less scheduling delay than its own timer had measured. The unused `credit()` method and `starvedMs` getter are removed.

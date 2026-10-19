---
"@cotal-ai/delivery": patch
---

The delivery daemon's transport health names its 250 ms tick period once and passes it to both the timer and the loop-lag meter that timer ticks. The two used to be separate literals, and changing one alone would charge every on-time firing as scheduler lag and move the broker-gone decision. The meter is now built only when the timer is armed, and a credential adoption no longer resets a meter that the next arming replaces. Behavior is unchanged.

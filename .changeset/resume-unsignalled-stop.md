---
"@cotal-ai/cli": patch
---

A broker or delivery stop that was cut off after it recorded the member `stopping` and before it sent the signal, for example when a foreground `up` lost its terminal while stopping its stack, no longer leaves the stack stuck. The member kept running under a stop it never received, and `down`, `down --abandon-stop` and `service stop` all refused. The next bare `up` or `down` now returns that record to `running`: `down` signals the process again and `up` reuses it.

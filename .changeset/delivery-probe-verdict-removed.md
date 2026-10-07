---
"@cotal-ai/delivery": patch
---

The delivery package no longer ships the broker-probe verdict that native transport health replaced. `brokerGoneVerdict`, `classifyProbe`, `DescheduleSampler` and the probe constants had no caller in the daemon, which decides broker loss from its resident connection, so they are deleted with the smoke cells and mutations that graded only them. `LoopLagMeter` now takes its interval as a required argument.

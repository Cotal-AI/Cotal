---
"@cotal-ai/lang": patch
---

`waitUntil` now enters its step through the same code as every other effect. The replay verdicts, the cancellation checks, the host stop, request-id recovery and the `begin` append were written out a second time for `waitUntil`, so a rule changed in one copy could leave waits replaying, stopping or recovering differently from the rest. Behaviour is unchanged.

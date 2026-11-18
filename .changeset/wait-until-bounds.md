---
"@cotal-ai/lang": minor
---

A `waitUntil` cadence must be at least one second, and every observation after the first counts toward the run's effect ceiling.

`every` under 1s is refused L3047, by the validator for string and no-expression template literals and at the call for a computed cadence. Each recorded observation after the first consumes one effect (L4009); cadence expiry or failure without a recorded observation adds no look cost. Refused retries retain earlier observations, so resume seeds their cost. Probe effects and effects already spent share the ceiling.

`every` times the remaining ceiling caps how long polling can last. Every 5 s for 24 h needs 17,280 observations, over the default 10,000 even before probe effects. No CLI or hosted start surface raises the ceiling today, only an embedder can set it through run pins. An in-flight sub-second cadence raises catchable L3047 on resume, so a program that catches it takes its catch branch instead of continuing the old cadence.

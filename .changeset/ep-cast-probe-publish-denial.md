---
"@cotal-ai/core": patch
---

Surface a broker-refused cast or liveness probe as `permission-denied` naming the refused subject. `epCast` resolved as success and `epProbeInstanceInterest` expired into `unknown` when the broker refused their publish, because a NATS publish violation is asynchronous while the publish call returns normally. Both verbs now watch the connection status with the shared publish-denial watch, registered before the publish and released on every path, so a refusal never reads as a cast that was sent or as a verdict-less probe that consumed its whole budget. The healthy paths are unchanged: an allowed cast settles on its flush round-trip, and only the broker's no-responders answer remains an affirmative `gone`.

---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

v0.4 endpoint control-surface: a breaking wire revision. Adds the endpoint control surface (SPEC section 13): the endpoint subject and grant grammar, record and journal contracts, and the session and virtual-endpoint composites. Completes the agent lifecycle from registration through despawn, retirement, and name reuse, with durables keyed by lifecycle uid so a manager-resumed agent recovers its original incarnation rather than re-minting.

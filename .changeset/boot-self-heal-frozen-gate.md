---
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

A manager that died mid-registration left the issuance gate frozen, and the successor refused to
register until an operator ran `cotal reconcile-gate`. Boot now completes that same dead
registration itself when the freeze-holder is affirmatively gone under a complete CONNZ sweep
(`gone` and `sweepComplete=true`), then continues the normal takeover. Live, unknown,
unestablishable, and wrong-op-kind still refuse; there is no TTL.

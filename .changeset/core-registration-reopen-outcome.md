---
"@cotal-ai/core": patch
---

`registerServiceInstance` no longer reports a reopen whose outcome is unknown as a gate left frozen. Its Phase-4 reopen and its abort reopen used one refusal for a reopen that lost its compare-and-set and for one that threw, and that refusal said the gate was left frozen for reconciliation, even when the reopen had committed and only its acknowledgement was lost. A lost compare-and-set now says a reconciler or newer barrier superseded the registration and nothing was reopened. A reopen that throws says its outcome is unknown and may have committed, as `completeFrozenRegistrationFromSpec` already does. Both stay `unavailable`, and the abort refusal still carries the aborting cause.

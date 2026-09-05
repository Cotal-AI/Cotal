---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Hold the endpoint governance slot through Phase-4 reopen so a concurrent deregister cannot delete the spec a registration is still completing. `deregisterServiceInstance` now requires an observe-only read of this instance's issuance-gate generation: matching the held slot is `registration-in-flight`; a slot behind that generation is a leftover after reopen and does not block.

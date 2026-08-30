---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"cotal-ai": patch
---

Resume an interrupted frozen endpoint-gate repair without repeating holder evictions that were
already verified. Progress is durably bound to the registration operation, frozen-gate revision,
and sorted holder set, while every retry still rechecks freeze-holder liveness. A mismatch restarts
from zero, each completion is persisted before the next verification, and the gate reopens only
after every current holder verifies. The endpoint executor can write only its exact repair key, and
post-reopen cleanup failure cannot authorize a later freeze.

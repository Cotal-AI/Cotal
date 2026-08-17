---
---

Test-only: adopts the smoke broker teardown helper in the seven `packages/core` suites that restart
or cluster their brokers, owning every live child rather than only the first. No shipped behaviour
changes, so no release.

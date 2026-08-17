---
---

Test-only: fixes three `packages/core` smoke suites that leaked a broker store dir on every passing
run, and corrects the helper's scope note, which generalised one suite's measurement to all of them.
No shipped behaviour changes, so no release.

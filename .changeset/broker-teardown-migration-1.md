---
---

Test-only: adopts the smoke broker teardown helper in four more `packages/core` suites, so a killed
suite tears its broker down instead of orphaning it. No shipped behaviour changes, so no release.

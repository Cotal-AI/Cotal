---
---

Test-only: adopts the smoke broker teardown helper in three more `implementations/auth` suites that
needed reading rather than a mechanical edit, including one that bounces its broker and so hands
ownership across the respawn. No shipped behaviour changes, so no release.

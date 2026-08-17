---
---

Test-only: adopts the smoke broker teardown helper across the `implementations/manager` suites, and
fixes three of them that never removed the scratch tree they minted, a leak reproduced by counting
directories around a green run. All the changed files are smoke suites, so no shipped behaviour
changes and no release.

---
---

Test-only: the forced-split arm of the describe/invoke probe now grades the caller-visible
contract instead of which class-queue member happens to answer, so a repair that is split a
second time, which is a correct and conclusive outcome, no longer reads as a failure. No
shipped behaviour changes, so no release.

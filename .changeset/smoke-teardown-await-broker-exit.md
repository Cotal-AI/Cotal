---
---

Test-only: the smoke teardown helper now waits for a broker to exit before its scratch tree is
removed, fixing an ENOTEMPTY that failed a CI shard after every cell had passed. Only smoke suites
and the private test kit change, so no release.

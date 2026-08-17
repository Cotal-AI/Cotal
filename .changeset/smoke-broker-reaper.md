---
---

Test-only: the `smoke:ci` runner now reaps `nats-server` processes left behind by a suite that was
killed before its teardown could run, matching only the store-dir token minted by the smoke teardown
helper. All the changed files are smoke infrastructure, so no shipped behaviour changes and no
release.

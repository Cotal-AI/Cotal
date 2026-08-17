---
---

Test-only: adds a smoke helper that owns a spawned `nats-server` so it is torn down when the suite
process is killed rather than only when the suite returns, plus a suite that reproduces the leak as a
positive control and asserts the limits, and adopts it in `bind-fence`. No shipped behaviour changes,
so no release.

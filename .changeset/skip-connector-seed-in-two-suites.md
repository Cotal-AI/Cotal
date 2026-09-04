---
"cotal-ai": patch
---

The `ps-operator-path` and `presence-ttl-refresh-cli` smoke suites opt their CLI out of the connector seed reconcile, as fifteen sibling suites already do and as `up` does for the daemons it launches. Neither suite exercises the seeder, and on a cold npm cache the reconcile can consume the whole `cotal up` budget the fixtures allow.

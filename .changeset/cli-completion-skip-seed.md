---
"@cotal-ai/cli": patch
---

`cotal completion` now skips the connector-seeding boot gate alongside `__complete` and `help`. Sourcing completion in shell startup profiles no longer acquires the operator-global reconcile lock or rewrites `stamp.json`, and running `cotal completion <shell>` from a development checkout no longer fails on the source checkout guard.

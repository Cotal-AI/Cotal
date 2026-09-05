---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

Refuse a source-checkout `cotal` from writing or GC'ing the operator-global seed store. A missing identity answer is a refusal, not a released install. The refusal names `$XDG_CONFIG_HOME` isolation, not the test-only `COTAL_ALLOW_CHECKOUT_SEED=1` override. An older CLI that meets a newer store is pointed at `cotal ext seed --force`, not `--reset`. `COTAL_HOME` does not relocate this store.

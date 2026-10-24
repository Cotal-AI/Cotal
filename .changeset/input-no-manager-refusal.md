---
"@cotal-ai/cli": patch
---

`input`, `stop` and `attach` refuse `TARGET_UNAVAILABLE` at once when no manager is running for the
space, as `ps` does, instead of waiting out the manager's answer deadline and reporting an
unconfirmed outcome for a request that was never sent.

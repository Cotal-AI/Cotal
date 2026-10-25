---
"@cotal-ai/cli": patch
---

`status --all --server <address>` no longer shows the `--server` connection's state in the selected
space's row under its recorded broker when `--server` names another address. That row now reports
the check of its own recorded address, as `meshes.items[].check` in `--json` already did, so a
recorded broker that answers no longer reads `unreachable` because the `--server` address did not.

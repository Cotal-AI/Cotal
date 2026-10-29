---
"@cotal-ai/cli": patch
---

`cotal ps` on a static or open space whose manager registry lists no live manager, such as a legacy
stack started with `--no-manager`, now refuses `TARGET_UNAVAILABLE`, exit 2. It says that no
manager is registered, so none was asked, and that this does not show that no manager process runs.
It used to fail with the generic `OPERATION_FAILED`, exit 5, as if `ps` itself had failed. Scripts
that read exit 5 for this case now get exit 2. `cotal status <agent>` and the `attach` picker read
the same list and refuse the same way. The registry's own answer stays under `error.cause`, and a
controller stack keeps its own refusals.

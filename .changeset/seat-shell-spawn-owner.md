---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/runtime": minor
---

`cotal spawn --detach` run from a managed seat's own shell on a static or open mesh now launches as that seat, so the manager records the seat as the spawner and the seat can stop the child with `cotal_despawn`, as it can a `cotal_spawn` child. Before, the CLI minted a one-shot operator instrument that no session could present again, and the seat's despawn was refused. `--on <instance>` keeps its pin on that path: on a static mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and carrying the spawn subject only when the seat's own credential holds it. On an open mesh the seat's call keeps the TLS requirement the mesh records, and `--server` with an unregistered `--space` keeps the operator path. Without `--space` the seat's target is picked as the operator path picks it, skipping a recorded mesh that is not running. The child is now stopped when the seat exits, and on a static mesh a seat without `capabilities: [spawn]` is refused. The seat-scoped control target that `cotal run` already used on a static mesh moves to `@cotal-ai/workspace` as `resolveSeatControlTarget`; `cotal run` keeps using it on a static mesh only. See docs/UPGRADING.md.

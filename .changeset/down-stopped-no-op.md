---
"@cotal-ai/cli": patch
---

Run `cotal down` again in a folder whose stack is already stopped, and it says so instead of refusing.

- A second bare `cotal down` reports that the folder's stack is not running and names `cotal up`, with outcome `no-op` and exit 0. It needs no `--yes` and writes nothing. `--dry-run`, `--json` and `--plain` show the same. A controller stack counts as stopped after its own completed `down`. A legacy root counts as stopped when no registration or top-level `*.pid` record remains and it still holds the broker configuration a start rendered there, or a space prepared there.
- Without that evidence a legacy root still refuses, now with one next step: `TARGET_NOT_FOUND` when nothing shows a stack there, `CONFLICT` naming the spaces when several registrations name the root, and `CONFLICT` pointing to `cotal status` when a process record remains with no registration.
- Before it reports the no-op, `down` reads every local-process record under the root: those of the stack's space and of every space the root's manager and delivery records name, and an installed extension's records at any path under `.cotal`. One whose process may still run, or that cannot be read, refuses `LIFECYCLE_BLOCKED` and points to `cotal status`. Nothing is stopped, adopted or removed.
- `--with-agents` on a stopped stack refuses `LIFECYCLE_BLOCKED` and says to start it first. Its preview, `cotal down --dry-run --with-agents`, shows the no-op.
- Outside a terminal, a bare `down` that would stop a running controller stack still requires `--yes`. The refusal is now one line and its remedy, without the command help.

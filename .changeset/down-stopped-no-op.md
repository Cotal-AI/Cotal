---
"@cotal-ai/cli": patch
---

Run `cotal down` again in a folder whose stack is already stopped, and it says so instead of refusing.

- A second bare `cotal down` reports that the folder's stack is not running and names `cotal up`, with outcome `no-op` and exit 0. It needs no `--yes` and writes nothing. `--dry-run`, `--json` and `--plain` show the same. A controller stack counts as stopped after its own completed `down`. A legacy root counts as stopped when no registration or process record remains and it still holds the broker configuration a start rendered there, or a space prepared there.
- Without that evidence a legacy root still refuses, now with one next step: `TARGET_NOT_FOUND` when nothing shows a stack there, `CONFLICT` naming the spaces when several registrations name the root, and `CONFLICT` pointing to `cotal status` when a process record remains with no registration.
- `--with-agents` on a stopped stack refuses `LIFECYCLE_BLOCKED` and says to start it first.
- Outside a terminal, a bare `down` that would stop a running controller stack still requires `--yes`. The refusal is now one line and its remedy, without the command help.

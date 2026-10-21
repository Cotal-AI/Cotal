---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Run `cotal down` again in a folder whose stack is already stopped, and it says so instead of refusing.

- A second bare `cotal down` reports that the folder's stack is not running and names `cotal up`, with outcome `no-op` and exit 0. It needs no `--yes` and writes nothing. `--dry-run`, `--json` and `--plain` show the same. A controller stack counts as stopped after its own completed `down`. A legacy root counts as stopped when no registration or top-level `*.pid` record remains and it still holds the broker configuration a start rendered there, or a space prepared there.
- Without that evidence a legacy root still refuses, now with one next step: `TARGET_NOT_FOUND` when nothing shows a stack there, `CONFLICT` naming the spaces when several registrations name the root, and `CONFLICT` pointing to `cotal status` when a process record remains with no registration.
- Before it reports the no-op, `down` reads every record a local-process descriptor names under the root, an installed extension's included, at any path under `.cotal` and for any space a record's name holds. One whose process may still run, that cannot be read or attributed, or whose space part decodes to no space refuses `LIFECYCLE_BLOCKED`. Nothing outside the root's `.cotal` is read: a link on a record's path refuses at the link, unread, as does a record that is not a regular file or is larger than a process record. A template whose `{space}` normalizes away is read as the one path it names. The refusal names each record with its path and pid, and its next step lists the pids and paths to check. Nothing is stopped, adopted or removed.
- `--with-agents` on a stopped stack refuses `LIFECYCLE_BLOCKED` and says to start it first. Its preview, `cotal down --dry-run --with-agents`, shows the no-op.
- Outside a terminal, a bare `down` that would stop a running controller stack still requires `--yes`. The refusal is now one line and its remedy, without the command help.

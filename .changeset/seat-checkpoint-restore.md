---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

Restore an admitted seat checkpoint on the destination, before the preserved resume starts.

A destination used to admit a checkpoint and then launch the seat against whatever happened to be at `launch.cwd`. The captured bundle, the two diffs and the untracked archive were written, digested and admitted, and nothing consumed them. `cotal up` now puts those bytes back, as a step of the preserved-resume path that runs after every gate has passed over every checkpoint and before a single writer generation is claimed, so a refusal costs nothing for the same reason a gate failure does.

Each seat stages beside its own `cwd`. Every recorded digest is verified again over the files as they are now; the bundle is cloned into `<cwd>.incoming`, refused when that path already exists; the recorded base commit is verified in the clone and checked out detached; the index diff is applied with `--index` and the worktree diff without it, both `--binary --allow-empty`; the untracked archive is extracted. Every seat stages before any seat is promoted, and promotion moves an existing `cwd` aside to `<cwd>.superseded.<timestamp>` before renaming the staging directory into place. Those two renames are the only steps that touch the path the seat will use, so a failure anywhere leaves every seat's live `cwd` as it was, promotes nothing and claims no generation. `git` and `tar` run as child processes with argument arrays, never a shell string.

A leftover `<cwd>.incoming` refuses by name and is never removed automatically: a staging directory from a failed run is the only record of what failed, so an operator inspects it and removes it by hand. A pre-existing `cwd` is renamed rather than deleted, so a wrong checkpoint costs a rename instead of a tree.

The promoted tree is verified once more. A checkpoint now records the seat's `git status --porcelain` as the cut read it, under the same selection rule the untracked set was produced under, and the restore re-reads it in the promoted tree and refuses a difference. Both applies can return 0 and still leave an index the source did not have, and this is the only check that sees it.

The session files travel the same way. The manager's resume entry carries the connector's `sessionStatePath` when the seat has one, `cotal down --preserve-state` takes `--session-store <path>` (repeatable, applied to every continuation-capable retained seat, refused when the path does not exist or is not a directory), and each captured session file records where it lands as an anchor plus a relative path rather than the source host's absolute spelling. The restore places them before the seat launches, so a connector that declares exact continuation is sealed and resumed as `exact` rather than capped. A pointer whose recorded `sessionId` is not the one the retained inventory reopens is refused before anything is cloned, and a session file already present at its destination is judged by content: equal bytes are already restored, different bytes are refused with both digests rather than clobbered.

`up --restore <dir>` reaches the same admission and the same restore, after the store is restored and validated and before commit intent is journaled. It previously handed a retained inventory to the manager with no gate run, no generation claimed and no restore.

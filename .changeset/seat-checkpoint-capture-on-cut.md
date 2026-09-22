---
"@cotal-ai/cli": patch
---

Capture a seat checkpoint during `down --preserve-state`, after the cut has proven the whole stack down.

Each retained seat gets `.cotal/maintenance/v1/checkpoints/<seat>/` holding a `git bundle` of its `cwd`'s reachable history anchored on a named base commit, the staging state as two diffs (base to index, index to worktree), the untracked files in scope, the harness session pointer and store when the connector declares them, and a `checkpoint.json` written last with every file's byte size and sha256. The command prints each checkpoint's path, continuity class and writer generation.

Capture runs only after the manager has proven every child exited and the endpoint is unreachable, because anything earlier races a harness still writing its transcript and its working tree. The staging state is two diffs rather than one so a mixed tree restores with the same index it was cut with.

The recorded untracked selection rule excludes the `.cotal/` control directory. When a seat's `cwd` is also the mesh root that directory is untracked, and without the exclusion the broker trust material, the space account, the manager instance identity's private seed and the seat's own credentials would be written into the artifact. A checkpoint carries credential references only.

A seat whose launch options could not be resolved is refused rather than checkpointed, in the manager's existing wording.

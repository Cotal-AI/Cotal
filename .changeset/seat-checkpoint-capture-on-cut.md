---
"@cotal-ai/cli": patch
---

Capture a seat checkpoint during `down --preserve-state`, after the cut has proven the whole stack down.

Each retained seat gets `.cotal/maintenance/v1/checkpoints/<attempt>/<seat>/` holding a `git bundle` of its `cwd`'s reachable history anchored on a named base commit, the staging state as two diffs (base to index, index to worktree), the untracked files in scope, the harness session pointer and store when the connector declares them, and a `checkpoint.json` written last with every file's byte size and sha256. The command prints each checkpoint's path, continuity class and writer generation. The preservation attempt is in the path because a sealed checkpoint is immutable: a shared directory would make the second cut in a root refuse on the first cut's leftovers.

Capture runs only after the manager has proven every child exited and the endpoint is unreachable, because anything earlier races a harness still writing its transcript and its working tree. The staging state is two diffs rather than one so a mixed tree restores with the same index it was cut with.

The recorded untracked selection rule excludes the `.cotal/` control directory. When a seat's `cwd` is also the mesh root that directory is untracked, and without the exclusion the broker trust material, the space account, the manager instance identity's private seed and the seat's own credentials would be written into the artifact. A checkpoint carries credential references only.

A seat whose launch options could not be resolved is refused at prepare time, while every child is still running, in the manager's existing wording. The decision reads only the prepared inventory, so refusing after the stack is down would cost the operator a running mesh to learn the cut could never complete.

The continuity class a checkpoint records is what the connector declares, capped by what the cut actually carried. The manager's resume inventory records no session pointer path, so a command-produced checkpoint carries no session bytes and a continuation-capable connector is recorded as `fresh` or `drain-only` rather than `exact`. A class is a promise a destination may act on, so it never describes bytes the artifact does not contain.

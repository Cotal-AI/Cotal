---
"@cotal-ai/cli": patch
---

`cotal backup restore` of a full artifact taken under another trust state, such as another machine's or a reset root's, now refuses `CONFLICT` (exit 2) and says the artifact restores only into a root that still holds the trust state it was taken under. It exited 3 `OPERATION_UNKNOWN` with a misleading Next, though nothing had changed. `cotal backup create`, `inspect` and `verify` now show a `Restores into` row for such an artifact, and their JSON carries `trustBound`.

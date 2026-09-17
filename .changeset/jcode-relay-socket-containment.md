---
"@cotal-ai/connector-jcode": minor
---

Keep the Jcode tool relay socket out of the shared temp directory, and contain self-test cleanups

The Jcode connector placed its control socket at the top level of `/tmp`. Anything that empties
that directory, a distribution's periodic cleaner or a self-test whose recursive cleanup escaped
its own root, unlinked the control path of every live seat at once. The hosts kept listening on
the now-nameless inodes, so every `cotal_*` call from those sessions failed with `connect ENOENT`,
and the only recovery was a respawn, which discards the session's context.

The socket now lives in a per-launch owner-only directory the host creates and removes with the
launch, so a top-level sweep does not reach it. A host whose socket path disappears anyway
re-binds at the same path within a poll interval and records it in the seat's private log, so a
deletion costs a reconnect instead of a respawn.

The escape that triggered it is closed at its own end too. A self-test's recursive cleanup may now
only remove the exact path its `mkdtemp` returned, and only where that path resolves strictly
beneath the base it was created in. A cleanup handed anything else refuses and exits 2 rather than
deleting, so a mutant that makes a directory helper return a parent can no longer reach another
process's files.

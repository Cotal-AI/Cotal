---
"@cotal-ai/workspace": patch
---

Stop reporting an unreadable project folder as several running meshes. When this account cannot read a
project folder's `.cotal/auth`, for example because it cannot enter the folder's `.cotal`, a command
that would target that folder used to refuse with `TARGET_AMBIGUOUS` and the empty message
`multiple meshes running: `. It now refuses with `DEPENDENCY_UNAVAILABLE` and names the folder and the
read error, with `--space <name>` as the next step. This includes the `--server` path. The account
inventory now treats only a missing auth folder as empty; any other read failure propagates. An
unreadable `.cotal/auth` no longer renders as `space "undefined"`. Explicit `--space`, a selected
space, and readable or absent projects are unchanged.

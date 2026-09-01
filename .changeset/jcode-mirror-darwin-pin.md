---
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-core": minor
---

Managed Jcode seats launch on macOS and the BSDs again. Credential mirroring pins each parent
directory so an ancestor swapped mid-walk cannot redirect a copy, mkdir, or unlink outside the
private home, and the only pin the connector had was `/dev/fd/<fd>/<name>`, which needs Linux
procfs traversal, so #1170 bounded managed seats to Linux to keep that guarantee.

The pin now has a second mechanism with the same contract. macOS and the BSDs pin the parent as the
process working directory: after `chdir`, a single-component name resolves from that directory's
inode and no ancestor is walked again, which is the same guarantee `/dev/fd/<fd>/<name>` provides on
Linux. `chdir` takes a path, so entry is verified rather than trusted: the entered directory's
inode must equal the inode of the descriptor opened a moment before, which closes the window between
the two. The previous working directory is restored on every exit, including the refusing ones.

The Linux path is unchanged. The suite's TOCTOU battery previously stood down to eighteen
unfailable `check(name, true)` cells off Linux; it now drives all of them on any POSIX platform,
including the three controls that show the unpinned pattern still deletes and leaks outside the
home. Two cells cover the working-directory pin's own failure modes.

Windows is unchanged and still refused before launch: Jcode's released Harness API bridge is a
Unix-socket surface.

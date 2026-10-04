---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A provenance line (`→ using`, `→ wrote`, `→ removed`) no longer fails or crashes a command when stderr is broken. When the stderr write throws or fails with an error such as EPIPE or ENOSPC, at once or after waiting in a full pipe whose reader goes away, the line is printed on stdout with the error and the command finishes its work. This holds for a write that throws a value that is not an Error, such as `null`. When stdout fails too, the command still finishes its work and exits 1 instead of 0, so a line no channel could carry is never lost silently. The same holds for a line still waiting in a full stderr pipe when the command exits, as when the CLI exits on a closed stdout. Node does not say which stderr bytes are still waiting, so a line that had to wait and got through just before the exit counts the same while later stderr output still waits. A connector seed run with a broken stderr used to commit every payload and then exit 1 with nothing said, or stop after the first payload and require `cotal ext seed --repair`. A stderr that is closed or redirected away at launch still discards the line.

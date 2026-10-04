---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A provenance line (`→ using`, `→ wrote`, `→ removed`) no longer fails or crashes a command when stderr is broken. When the stderr write throws or the stream reports an error such as EPIPE or ENOSPC, the line is printed on stdout with the error and the command finishes its work. A connector seed run with a broken stderr used to commit every payload and then exit 1 with nothing said, or stop after the first payload and require `cotal ext seed --repair`. A stderr that is closed or redirected away at launch still discards the line.

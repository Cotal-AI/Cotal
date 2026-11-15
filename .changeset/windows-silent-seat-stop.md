---
"@cotal-ai/workspace": patch
"@cotal-ai/manager": patch
---

Stop Windows `pty` seats even when they have not written to their terminal. On Windows, stopping a `pty` seat now pins the launched root process, snapshots and pins its descendant process tree before cooperative shutdown grace, terminates any surviving members through their retained process handles after grace, and frees the seat only after every captured process and the PTY have exited.

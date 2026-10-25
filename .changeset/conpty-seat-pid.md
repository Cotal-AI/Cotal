---
"@cotal-ai/manager": patch
---

A Windows pty seat now reports its real process id. ConPTY creates the child after the spawn
returns, and the manager kept the pid it read then, which was 0, so `ps --wide` and the reap line
named pid 0 for a Windows seat. The pid is now read when asked, and it is absent until ConPTY has
created the process.

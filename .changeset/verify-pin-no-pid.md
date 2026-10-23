---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal down` over an empty manager pidfile no longer warns that an older manager may have reaped its managed agents. No manager ran there and nothing was signalled. `verifyIdentityPin` now answers `no-pid` for a pidfile that is absent, empty or holds no pid, where it used to answer `legacy`, the verdict for a live record written before identity pinning. A pidfile it cannot read for any reason other than its absence now throws, naming the file.

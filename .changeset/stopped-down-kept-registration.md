---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A second bare `cotal down` in a stopped project whose space is named after its folder now reports
that the stack there is not running, names `cotal up`, and exits 0. Since that space keeps its
registration after `down`, it exited 1 with only "Nothing running for the local stack (no recorded
pidfiles)." and no next step.

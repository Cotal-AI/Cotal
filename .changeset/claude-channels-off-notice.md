---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A plain spawn of a Claude seat whose startup showed no development-channels prompt now says that mesh traffic does not wake the seat while idle: the spawn result carries `startupNotice`, `cotal spawn` prints a `STARTUP_NOTICE` warning, the `cotal_spawn` result ends with the notice, and `cotal ps` marks the seat `no idle wake`. A connector declares this with `idleWakeNeedsConfirmed`.

---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

Rename the private envelope-conflict check in the lifecycle saga and the admission mediator so it no longer shadows core's exported `isCasLoss`. No behaviour change.

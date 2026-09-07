---
"cotal-ai": minor
"@cotal-ai/seat": minor
---

Ship linux-x64 and linux-arm64 SO_PEERCRED helpers from native builder jobs, assembled before pack and publish. `waitForExit` drops the controller socket so a manager worker can exit after the child is gone.

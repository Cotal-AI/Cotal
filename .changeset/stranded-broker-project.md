---
"@cotal-ai/cli": patch
---

Point interrupted broker recovery at the project that owns the broker. When startup uses `--root` from another folder and stops before registering the space, both the interrupt notice and the next startup refusal give a stop command for that project.

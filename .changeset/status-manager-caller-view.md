---
"@cotal-ai/cli": patch
---

`cotal status --components` asks for manager status with the manager-caller view a spawn holder already uses. When this machine's manager process is live, that call is pinned to the instance id the process persisted. An unknown id, or an answer from another instance, is refused rather than reported as this process serving. An answer names the instance that gave it. A probe refused before any answer says so. With no local manager process, an unpinned answer is still serving and the row names that instance. Other component probes, `ps`, and `slots` stay unchanged.

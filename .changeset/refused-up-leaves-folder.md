---
"@cotal-ai/cli": patch
---

A refused `cotal up` no longer leaves `.cotal/maintenance` in a folder that had none. `up -f` with a manifest that does not validate or a flag it contradicts, and `up --json` on the retained launcher, used to leave that folder, with a stale lock after `up -f`, and commands run there afterwards treated the folder as a project of space `main` on 127.0.0.1:4222. The lock now removes the folders it created, while they are still empty, when the command refuses or fails.

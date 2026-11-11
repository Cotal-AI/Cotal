---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Updating from a version before 0.159.1 on a computer that hosts a Manager no longer fails its first run at the continuity check. The update waits for the restarted daemon before it checks, as it did before 0.159.1.

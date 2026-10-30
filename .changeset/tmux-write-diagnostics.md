---
"@cotal-ai/tmux": patch
---

Preserve tmux's failure reason when creating a session, selecting a window or sending text and keys. Driver errors name the operation and retain the failed call as their cause; session-creation refusals also reach runtime spawn callers.

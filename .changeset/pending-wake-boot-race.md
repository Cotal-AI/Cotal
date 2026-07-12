---
"@cotal-ai/connector-claude-code": patch
---

Fix the boot lost-wake race that left a session spawned with a message already pending permanently deaf: reconcile the wake once the claude/channel handshake activates, and add a 30s idle reconciler that re-nudges whenever wake-pending messages sit in the inbox while the session is idle.

---
"@cotal-ai/pi": patch
---

Keep Pi message delivery working after an extension reload or session resume.
Reuse the retained authenticated runtime before reading one-shot launch material so lifecycle hooks rebind the driver and queued DMs can reach a clean terminal commit.

---
"@cotal-ai/connector-claude-code": patch
---

Keep a `once` task off a hook frame that a turn end, session end or replacing session overtook while the frame was being built. The task stays unclaimed for the next frame, instead of being confirmed for a session that had already ended.

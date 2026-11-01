---
"@cotal-ai/connector-opencode": patch
---

An OpenCode 2.x setup that the host refuses no longer leaves its mesh agent joined: the agent start is queued only after the host's hook and tool registrations succeed.

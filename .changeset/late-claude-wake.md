---
"cotal-ai": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
---

Daemon-hosted Managers now register the Claude Code wake channel when Claude appears on their existing PATH, without a restart. Claude stays unavailable until setup succeeds and reports the cause if setup fails. Disconnect cancels in-progress registration and waits for its native command to exit.

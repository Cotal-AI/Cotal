---
"@cotal-ai/connector-claude-code": patch
---

The Claude Code event mapper now exposes only what the connector calls: `map` and `forgetOpenRun`. It drops `closeOpenRun`, `openRun` and `diagnose`, which nothing shipped called. The `Stop` and `StopFailure` hooks close a session's last run through the event holder, and the mapper's header now says so instead of saying that run never closes. No behavior changes.

---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

On Windows, a confirmed `cotal down` now ends foreground `cotal up` successfully, and a stopped PTY seat releases its console host so it does not block stack shutdown.

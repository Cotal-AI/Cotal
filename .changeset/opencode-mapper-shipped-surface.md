---
"@cotal-ai/connector-opencode": patch
---

The OpenCode event mapper now exposes only what the plugin calls: `map` and `forgetOpenRun`. It dropped `closeOpenRun`, `openRun` and `diagnose`, which nothing shipped called. The run closes the record stream cannot see, at `session.idle` and `session.error`, go through the event holder and never went through the mapper, and `diagnose` could only ever report that no assistant record had arrived. No behavior changes.

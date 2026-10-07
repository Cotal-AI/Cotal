---
"@cotal-ai/connector-opencode": patch
---

Restate the comment above the OpenCode plugin's `shutdown` as the rule it carries: the exit waits for the shared teardown to settle and runs whether that teardown resolves or rejects. It no longer compares the exit with an earlier version, a comparison that suggested a teardown that throws keeps the process running. No behavior changes.

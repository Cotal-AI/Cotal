---
"@cotal-ai/cli": patch
---

When a separately started service blocks foreground startup, the recovery advice keeps the original foreground invocation instead of suggesting a background start.

---
"@cotal-ai/cli": patch
---

When `spawn` receives both `--live-only` and `--runtime` in the foreground, it recommends dropping `--runtime` instead of switching to a manager that would reject `--live-only`.

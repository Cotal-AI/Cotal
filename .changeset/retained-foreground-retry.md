---
"@cotal-ai/cli": patch
---

When foreground startup finds a running legacy broker, return a lifecycle refusal. Identify where to stop the broker and keep the original foreground request for the retry.

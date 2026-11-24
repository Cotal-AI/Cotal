---
"@cotal-ai/cli": patch
---

Legacy `cotal up --foreground` waits up to 65 seconds for TIME-WAIT to clear and retries the same broker address instead of asking you to restart again.

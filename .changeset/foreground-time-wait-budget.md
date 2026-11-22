---
"@cotal-ai/cli": patch
---

On Linux, restarting a controller stack waits up to 65 seconds for TIME-WAIT to clear so a broker port released just after one minute can be reused without another command.

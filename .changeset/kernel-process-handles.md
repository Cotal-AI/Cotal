---
"@cotal-ai/seat": minor
---

Add Linux kernel process handles for owned local process observation.

Capture connected Unix peers without a numeric-PID lookup, recover only matching recorded identities, and observe exit with cancellable kernel readiness events. Closing a handle releases observation without declaring that work ended. The built-in PTY runtime still refuses automatic restart without work-closure support.

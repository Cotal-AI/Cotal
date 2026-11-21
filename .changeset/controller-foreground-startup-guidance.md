---
"@cotal-ai/cli": patch
---

When a foreground controller stack is starting, a concurrent command now tells you whether to wait or stop it in the owning terminal. Another foreground start needs the first terminal to release the stack. A detached start can retry after startup without stopping it.

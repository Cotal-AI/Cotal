---
"@cotal-ai/cli": patch
---

When a foreground controller stack is starting, a concurrent start now tells you how to inspect it and stop it before starting it in another terminal. The startup lock records foreground ownership so the refusal points to `cotal status` and Ctrl-C in the owning terminal.

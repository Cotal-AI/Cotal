---
"@cotal-ai/cli": patch
---

When a controller stack is starting in the foreground, a competing `cotal up` that hits the startup lock tells you how to inspect the stack and stop it before starting it in another terminal.

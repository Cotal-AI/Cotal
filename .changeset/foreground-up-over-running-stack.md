---
"@cotal-ai/cli": patch
---

`up --foreground` on a stack that was already running took over its lifetime without saying so, and a second foreground `up` on a stack another terminal held did the same, so Ctrl-C in either stopped the whole stack. A second foreground `up` now refuses `CONFLICT` while another foreground `up` holds the stack, naming that process. Over a running stack that no terminal holds, it says before it blocks that the stack is already running and that Ctrl-C there stops the whole stack.

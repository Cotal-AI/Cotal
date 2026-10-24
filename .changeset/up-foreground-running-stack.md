---
"@cotal-ai/cli": patch
---

`cotal up --foreground` refuses when this folder's stack is already running, naming `cotal down` first. It used to print `already running`, restart a missing manager in the background and exit 0, so a `Type=simple` service unit read the exit as the stack ending and restarted in a loop.

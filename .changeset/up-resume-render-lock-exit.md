---
"@cotal-ai/cli": patch
---

The up-resume-render-lock live smoke exits on its own after its verdict, because the timers it raced against its children's exits are cleared when the child exits instead of keeping the process alive until the longest of them fires.

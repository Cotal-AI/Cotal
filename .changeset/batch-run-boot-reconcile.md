---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"cotal-ai": patch
---

Managers can recover interrupted workflows at startup in spaces with large run histories. Startup batches the run inventory and reads each recovery candidate separately before taking it back. Operator credentials keep the same scope and lifetime.

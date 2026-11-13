---
"@cotal-ai/manager": patch
"@cotal-ai/connector-jcode": patch
---

`cotal down` stops a process-bound seat gracefully, and a jcode seat signals its private daemon before the rest of its shutdown. A hard kill left that daemon running after the seat's terminal process was gone.

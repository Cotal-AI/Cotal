---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
"@cotal-ai/manager": patch
---

A process's pidfile and its identity pin now publish as one rename-based transition, so a crash between the two writes never leaves a torn pair (old pid beside a new pin, or a new pid beside an old one). A crash still leaves one of the legacy shapes teardown already handles.

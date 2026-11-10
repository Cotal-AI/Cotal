---
"@cotal-ai/workspace": patch
---

Chat reports broker disconnects promptly, including outages that recover before reconnect attempts finish.
The shared chat session follows transport events while keeping full-bind readiness separate, so a socket reconnect does not mark an unfinished rebuild connected.

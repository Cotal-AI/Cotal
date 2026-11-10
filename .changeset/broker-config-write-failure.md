---
"@cotal-ai/cli": patch
---

Report broker configuration write failures without suggesting a manager-free restart.
The failure names the configuration path and filesystem error code and records a known outcome before any member starts.
Non-regular entries, including FIFOs and Unix sockets, refuse with the move-aside remedy.

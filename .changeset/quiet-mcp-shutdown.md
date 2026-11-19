---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Fix `cotal mcp` shutdown so closing a stdio client retires its local identity without waiting for another CLI process or expired shutdown timers.

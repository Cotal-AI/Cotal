---
"@cotal-ai/connector-opencode": patch
---

In the OpenCode 1.x adapter, a message that arrives while a turn runs now drives its own turn after the user stops that turn, instead of sitting buffered until unrelated traffic arrives.

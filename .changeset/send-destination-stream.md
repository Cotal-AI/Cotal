---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal send` refuses when the stream that stores that destination is confirmed missing. A channel post checks the chat stream, a direct message the DM stream, and a role send the task stream. A direct message is still stored when only the chat stream is gone. A read that fails does not refuse.

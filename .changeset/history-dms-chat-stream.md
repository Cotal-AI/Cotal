---
"@cotal-ai/cli": patch
---

`cotal history --dms` returns a direct message that is still stored when the chat stream is gone, and warns that channel history is not shown. It no longer refuses with the message that says to create every stream again, empty.

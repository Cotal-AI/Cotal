---
"@cotal-ai/core": patch
---

Fail a channel or presence registry read when its connection closes before the broker answers.

A `cotal_send` made while the space was shutting down could wait forever on that read: the close cancels the read's own five-second timeout without ending it. The read now fails at the close, so the send goes on to report that the mesh is not connected.

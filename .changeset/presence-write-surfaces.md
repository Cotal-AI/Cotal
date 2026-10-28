---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

Report the recorded connection failure when sends or DMs cannot bind, including a
refused first presence write. Inbox replies now identify a connection that is not
ready while continuing to return locally buffered messages.

A timed-out presence update reports that its outcome is unknown and may have landed.

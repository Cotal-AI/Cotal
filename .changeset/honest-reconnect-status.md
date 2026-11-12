---
"@cotal-ai/connector-core": patch
---

Reconnect now warns when ambient channel delivery still requires a session restart.
The response distinguishes transport recovery from exhausted channel drop tracking and explains that direct messages, anycast and fresh unmuted mentions remain available.

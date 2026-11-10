---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

A membership follow stays running through a broker outage that lasts longer than the connection's own reconnect.

When the watch closes, the follow reports the lost connection once and reads the feed again once the endpoint re-establishes it. The gap and the current census follow, and the follow ends on an interrupt or a credential that can no longer connect (#6041).

---
"@cotal-ai/cli": patch
---

Use the same command-attribution check for manager and delivery shutdown. Both clear stale records naming another program without signalling it, including when the record has an identity pin.

Clearing a foreign legacy manager record no longer warns that a SIGTERM handler may have reaped agents when no stop was requested.

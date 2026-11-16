---
"@cotal-ai/connector-codex": patch
---

Pause automatic redelivery after a Codex message has failed three turns.

The first turn and two retries share one budget across broker redelivery while the message remains buffered. Exhausted messages stay unacknowledged and readable with cotal_inbox. The host log and seat status name them, and unrelated messages can still run. A host-process restart starts a new budget. Model output alone never acknowledges a message.

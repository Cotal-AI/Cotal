---
"@cotal-ai/connector-opencode": patch
---

The OpenCode 2.x adapter no longer injects peer messages into a native prompt while a batch it drove is still open. It used to prefix the typed prompt with everything in the inbox, the open batch included, and then ack all of it when the turn ended, so the first message went out twice and a message that arrived during the turn was acked without its own turn. The 1.x and 2.x adapters now keep the turn's batch in one shared place, so the ack boundary has a single definition and both refuse the same way.
